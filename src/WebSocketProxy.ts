// ============================================================
// Telegram WEB proxy v1 - one relay session (Durable Object)
//
//   app --(WEB proxy frames over one WebSocket)--> this DO
//       OPEN  -> new logical stream
//       DATA  -> MTProxy-obfuscated bytes: first 64 bytes = init packet
//                (decrypted with the secret to learn the DC), then transcoded
//                to a plain obfuscated2 connection to that Telegram DC
//
// Flow control follows PROTOCOL.md: 4 MiB credit per stream and direction,
// WINDOW returned only after bytes reached the DC socket.
// ============================================================
import { connect } from 'cloudflare:sockets';
import {
  FrameType, INITIAL_WINDOW, MAX_DATA_CHUNK,
  parseBatch, readWindowDelta, buildData, buildClose, buildWindow,
  decodeSecret, concat,
  type Frame,
} from './protocol';
import { accept, initiate, mtproxySecret, type CtrStream } from './obfuscated2';
import { DC_ADDRESSES, DC_PORT, resolveDc } from './dc';

type Socket = ReturnType<typeof connect>;

interface Env {
  PROXY_SECRET: string;
}

const MAX_STREAMS = 32;          // live streams per session
const MAX_TOMBSTONES = 4096;     // remembered closed ids (never reusable)
const CONNECT_TIMEOUT_MS = 10_000;
const INIT_LEN = 64;

// Diagnostics only: never log secrets, tokens or payload bytes.
const log = (...a: unknown[]): void => console.log('[do]', ...a);

interface StreamState {
  id: number;
  closed: boolean;
  connected: boolean;
  hs: Uint8Array[];              // bytes buffered until the 64-byte init is complete
  hsLen: number;
  recvCredit: number;            // how much the client may still send us
  sendCredit: number;            // how much we may still send the client
  creditWake: (() => void) | null;
  uplink: Promise<void>;         // serializes processing of this stream's DATA
  socket: Socket | null;
  writer: WritableStreamDefaultWriter<Uint8Array> | null;
  fromClient: CtrStream | null;  // decrypt client -> relay
  toClient: CtrStream | null;    // encrypt relay -> client
  dcEnc: CtrStream | null;       // encrypt relay -> DC
  dcDec: CtrStream | null;       // decrypt DC -> relay
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });

const pickSubprotocol = (header: string | null): string | null => {
  if (!header) return null;
  for (const part of header.split(',')) {
    const p = part.trim();
    if (p.startsWith('tproxy-v1.')) return p;
  }
  return null;
};

export class WebSocketProxy implements DurableObject {
  private mtSecret: Uint8Array;
  private ws: WebSocket | null = null;
  private dead = false;
  private streams = new Map<number, StreamState>();
  private tombstones = new Set<number>();
  private msgCount = 0;
  private inbox: Promise<void> = Promise.resolve(); // keeps message order while converting Blob -> ArrayBuffer

  constructor(_state: DurableObjectState, env: Env) {
    this.mtSecret = mtproxySecret(decodeSecret(env.PROXY_SECRET));
  }

  // The Worker has already authenticated the session token before routing here.
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;

    if (path === '/close') {
      this.shutdown(1000, 'session deleted');
      return new Response(null, { status: 204 });
    }

    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }
    // One multiplexed WebSocket per session; a dead session is never resumed.
    if (this.dead || this.ws) {
      log('attach refused:', this.dead ? 'session dead' : 'already attached');
      return new Response('Session unavailable', { status: 409 });
    }

    const proto = pickSubprotocol(request.headers.get('Sec-WebSocket-Protocol'));
    if (!proto) return new Response('Bad subprotocol', { status: 400 });

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    // With recent compatibility dates binary messages default to Blob; ask for ArrayBuffer.
    (server as unknown as { binaryType: string }).binaryType = 'arraybuffer';
    this.ws = server;
    log('attached (build 2: binary-message fix)');

    server.addEventListener('message', (ev: MessageEvent) => this.onMessage(ev));
    server.addEventListener('close', (ev: CloseEvent) => {
      log('ws close event: code', ev.code, 'reason', ev.reason);
      this.shutdown(1000, 'client closed');
    });
    server.addEventListener('error', () => {
      log('ws error event');
      this.shutdown(1011, 'socket error');
    });

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { 'Sec-WebSocket-Protocol': proto },
    });
  }

  // ---------------- inbound ----------------

  private onMessage(ev: MessageEvent): void {
    const data: unknown = ev.data;
    // Always go through one chain so ordering holds even if some messages need an async Blob read.
    this.inbox = this.inbox.then(async () => {
      if (this.dead) return;
      const buf = await this.toArrayBuffer(data);
      if (!buf) {
        log('non-binary message:', Object.prototype.toString.call(data), String((data as { constructor?: { name?: string } } | null)?.constructor?.name));
        this.shutdown(1003, 'binary messages only');
        return;
      }
      this.handleBatch(buf);
    }).catch((e) => {
      log('inbound error:', String(e));
      this.shutdown(1011, 'internal error');
    });
  }

  private async toArrayBuffer(data: unknown): Promise<ArrayBuffer | null> {
    const tag = Object.prototype.toString.call(data);
    if (data instanceof ArrayBuffer || tag === '[object ArrayBuffer]') return data as ArrayBuffer;
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength).slice().buffer;
    }
    // Blob (duck-typed so it also works across runtime realms)
    const blobLike = data as { arrayBuffer?: () => Promise<ArrayBuffer> } | null;
    if (blobLike && typeof blobLike.arrayBuffer === 'function') return blobLike.arrayBuffer();
    return null;
  }

  private handleBatch(buf: ArrayBuffer): void {
    let frames: Frame[];
    try {
      frames = parseBatch(new Uint8Array(buf), 'from-client');
    } catch (e) {
      log('malformed batch:', String(e), 'bytes', buf.byteLength);
      this.shutdown(1002, 'malformed batch');
      return;
    }
    if (this.msgCount++ < 40) {
      log('batch', frames.map((f) => `0x${f.type.toString(16)}#${f.streamId}/${f.payload.length}`).join(' '));
    }
    for (const f of frames) {
      if (this.dead) break;
      this.onFrame(f);
    }
  }

  private onFrame(f: Frame): void {
    switch (f.type) {
      case FrameType.OPEN:
        this.onOpen(f.streamId);
        break;
      case FrameType.DATA:
        this.onData(f);
        break;
      case FrameType.WINDOW: {
        const s = this.find(f.streamId);
        if (s) {
          s.sendCredit = Math.min(s.sendCredit + readWindowDelta(f), 0xffffffff);
          const wake = s.creditWake;
          s.creditWake = null;
          wake?.();
        }
        break;
      }
      case FrameType.CLOSE: {
        const s = this.find(f.streamId);
        if (s) this.closeStream(s, false);
        break;
      }
      case FrameType.PONG:
        break;
      default:
        // HELLO belongs to the HTTPS session creation, never to the WebSocket.
        log('unexpected frame type 0x' + f.type.toString(16));
        this.shutdown(1002, 'unexpected frame');
    }
  }

  /** Live stream, or null (late frame for a closed id is ignored; unknown id is fatal). */
  private find(id: number): StreamState | null {
    const s = this.streams.get(id);
    if (s) return s;
    if (!this.tombstones.has(id)) {
      log('frame for unknown stream', id);
      this.shutdown(1002, 'unknown stream');
    }
    return null;
  }

  private onOpen(id: number): void {
    if (this.streams.has(id) || this.tombstones.has(id)) {
      log('stream id reused', id);
      this.shutdown(1002, 'stream id reused');
      return;
    }
    if (this.streams.size >= MAX_STREAMS) {
      this.remember(id);
      this.send(buildClose(id));
      return;
    }
    this.streams.set(id, {
      id,
      closed: false,
      connected: false,
      hs: [],
      hsLen: 0,
      recvCredit: INITIAL_WINDOW,
      sendCredit: INITIAL_WINDOW,
      creditWake: null,
      uplink: Promise.resolve(),
      socket: null,
      writer: null,
      fromClient: null,
      toClient: null,
      dcEnc: null,
      dcDec: null,
    });
  }

  private onData(f: Frame): void {
    const s = this.find(f.streamId);
    if (!s) return;
    const len = f.payload.length;
    if (len > s.recvCredit) {
      this.closeStream(s, true); // client overran the window we granted
      return;
    }
    s.recvCredit -= len;
    const payload = f.payload;
    s.uplink = s.uplink
      .then(() => this.processUplink(s, payload))
      .catch(() => this.closeStream(s, true));
  }

  // ---------------- client -> DC ----------------

  private async processUplink(s: StreamState, payload: Uint8Array): Promise<void> {
    if (s.closed) return;

    if (!s.connected) {
      s.hs.push(payload);
      s.hsLen += payload.length;
      if (s.hsLen < INIT_LEN) {
        this.grant(s, payload.length);
        return;
      }
      const all = concat(...s.hs);
      s.hs = [];
      await this.connectStream(s, all.subarray(0, INIT_LEN));
      if (s.closed) return;
      if (all.length > INIT_LEN) await this.forwardUp(s, all.subarray(INIT_LEN));
      this.grant(s, payload.length);
      return;
    }

    await this.forwardUp(s, payload);
    this.grant(s, payload.length);
  }

  private async forwardUp(s: StreamState, bytes: Uint8Array): Promise<void> {
    if (s.closed || !s.fromClient || !s.dcEnc || !s.writer) return;
    const plain = await s.fromClient.process(bytes);
    const out = await s.dcEnc.process(plain);
    await s.writer.write(out);
  }

  private async connectStream(s: StreamState, init: Uint8Array): Promise<void> {
    let acc;
    try {
      acc = await accept(init, this.mtSecret); // fails for a wrong secret: this is the auth check
    } catch (e) {
      log('stream', s.id, 'init rejected:', String(e));
      this.closeStream(s, true);
      return;
    }
    const dc = resolveDc(acc.dcId);
    if (dc === null) {
      log('stream', s.id, 'bad dc id', acc.dcId);
      this.closeStream(s, true);
      return;
    }

    let socket: Socket;
    try {
      socket = connect({ hostname: DC_ADDRESSES[dc], port: DC_PORT });
      await withTimeout(socket.opened, CONNECT_TIMEOUT_MS);
    } catch (e) {
      log('stream', s.id, 'connect to dc', dc, 'failed:', String(e));
      this.closeStream(s, true);
      return;
    }
    if (s.closed) {
      Promise.resolve(socket.close()).catch(() => {});
      return;
    }

    const dcSide = await initiate(acc.tag, acc.dcId);
    const writer = socket.writable.getWriter();
    await writer.write(dcSide.wire);

    s.socket = socket;
    s.writer = writer;
    s.fromClient = acc.fromClient;
    s.toClient = acc.toClient;
    s.dcEnc = dcSide.enc;
    s.dcDec = dcSide.dec;
    s.connected = true;
    log('stream', s.id, 'connected: dc', dc, 'tag 0x' + acc.tag[0].toString(16));
    if (s.closed) {
      Promise.resolve(socket.close()).catch(() => {});
      return;
    }
    void this.pumpDown(s, socket.readable.getReader());
  }

  // ---------------- DC -> client ----------------

  private async pumpDown(s: StreamState, reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done || s.closed) break;
        if (!value || value.length === 0) continue;
        const plain = await s.dcDec!.process(value);
        const out = await s.toClient!.process(plain);
        await this.sendWithCredit(s, out);
      }
    } catch {
      // fall through to close
    } finally {
      if (!s.closed) this.closeStream(s, true);
    }
  }

  private async sendWithCredit(s: StreamState, bytes: Uint8Array): Promise<void> {
    let off = 0;
    while (off < bytes.length) {
      while (s.sendCredit <= 0 && !s.closed && !this.dead) {
        await new Promise<void>((resolve) => { s.creditWake = resolve; });
      }
      if (s.closed || this.dead) return;
      const n = Math.min(MAX_DATA_CHUNK, s.sendCredit, bytes.length - off);
      this.send(buildData(s.id, bytes.subarray(off, off + n)));
      s.sendCredit -= n;
      off += n;
    }
  }

  // ---------------- helpers ----------------

  private grant(s: StreamState, n: number): void {
    if (s.closed || n <= 0) return;
    s.recvCredit += n;
    this.send(buildWindow(s.id, n));
  }

  private send(frame: Uint8Array): void {
    if (this.dead || !this.ws) return;
    try { this.ws.send(frame as Uint8Array<ArrayBuffer>); } catch { /* socket already gone */ }
  }

  private remember(id: number): void {
    this.tombstones.add(id);
    if (this.tombstones.size > MAX_TOMBSTONES) {
      const oldest = this.tombstones.values().next().value;
      if (oldest !== undefined) this.tombstones.delete(oldest);
    }
  }

  private closeStream(s: StreamState, notifyClient: boolean): void {
    if (s.closed) return;
    s.closed = true;
    log('stream', s.id, 'closed', notifyClient ? '(by relay)' : '(by client)');
    this.streams.delete(s.id);
    this.remember(s.id);
    const wake = s.creditWake;
    s.creditWake = null;
    wake?.();
    try { if (s.socket) Promise.resolve(s.socket.close()).catch(() => {}); } catch { /* ignore */ }
    if (notifyClient) this.send(buildClose(s.id));
  }

  private shutdown(code: number, reason: string): void {
    if (this.dead) return;
    this.dead = true;
    log('shutdown:', code, reason);
    for (const s of [...this.streams.values()]) this.closeStream(s, false);
    try { this.ws?.close(code, reason); } catch { /* ignore */ }
    this.ws = null;
  }
}

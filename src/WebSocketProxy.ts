// ============================================================
// Telegram WEB Proxy v1 — Durable Object Session Handler
// Bridges WebSocket (client) <-> TCP (Telegram DC)
// ============================================================

import { connect } from 'cloudflare:sockets';
import {
  FrameType, parseFrame, buildWelcome, buildData,
  buildClose, buildPong, dataPayload, decodeSecret,
  DC_ADDRESSES, DC_PORT,
  type ParsedFrame,
} from './protocol';

// Socket type derived from connect() return type.
type Socket = ReturnType<typeof connect>;

// ---- Protocol constants ----
// Must match NONCE_LEN in protocol.ts
const EXPECTED_NONCE_LEN = 16;

// Flow-control defaults, aligned with the official spec.
const INITIAL_WINDOW = 4 << 20;   // 4 MiB per stream
const MAX_STREAMS    = 32;         // max concurrent streams per session

// Safety valve for the inbound accumulation buffer.
const MAX_RECV_BUF   = 4 << 20;    // 4 MiB

// ---- Protocol error codes (CLOSE payload) ----
const ERR_BAD_HELLO       = 0x01;
const ERR_WINDOW_EXCEEDED = 0x02;
const ERR_TCP_WRITE       = 0x03;
const ERR_TOO_MANY_STREAMS= 0x04;
const ERR_UNKNOWN_DC      = 0x05;
const ERR_TCP_CONNECT     = 0x06;

interface Env {
  // Placeholder for future bindings (analytics, KV, etc.)
}

interface Stream {
  socket: Socket;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  windowSize: number;
  openedAt: number;
}

export class WebSocketProxy implements DurableObject {
  private state: DurableObjectState;
  private env: Env;

  // ---- Per-connection state ----
  private ws: WebSocket | null = null;
  private secret: Uint8Array | null = null;
  private handshakeDone = false;
  private streams = new Map<number, Stream>();
  private recvBuffer: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  private alive = false;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env   = env;
  }

  // ============================================================
  // Entry point: WebSocket upgrade
  // ============================================================
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }
    if (!request.headers.get('Sec-WebSocket-Key')) {
      return new Response('Missing Sec-WebSocket-Key', { status: 400 });
    }

    const url = new URL(request.url);
    const secretHex = url.searchParams.get('secret');
    if (!secretHex) {
      return new Response('Missing secret', { status: 400 });
    }

    let secret: Uint8Array;
    try {
      secret = decodeSecret(secretHex);
    } catch {
      return new Response('Invalid secret', { status: 400 });
    }

    // Tear down any previous session cleanly.
    if (this.alive) {
      await this.shutdown('replaced-by-new-session');
    }

    this.secret        = secret;
    this.handshakeDone = false;
    this.streams       = new Map();
    this.recvBuffer    = new Uint8Array(0);

    const pair   = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    this.ws    = server;
    this.alive = true;

    server.addEventListener('message', (ev: MessageEvent) => {
      // Cloudflare delivers either ArrayBuffer (binary) or string (text).
      // We only expect binary frames.
      const data = ev.data;
      const buf = typeof data === 'string'
        ? new TextEncoder().encode(data).buffer
        : (data as ArrayBuffer);

      this.onClientMessage(buf).catch((err) => {
        console.error('[ws-msg]', err);
        this.shutdown('client-error').catch(() => {});
      });
    });

    server.addEventListener('close', () => {
      this.shutdown('ws-closed').catch(() => {});
    });

    server.addEventListener('error', () => {
      this.shutdown('ws-error').catch(() => {});
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  // ============================================================
  // Inbound buffering and frame dispatch
  // ============================================================
  private async onClientMessage(data: ArrayBuffer): Promise<void> {
    const bytes = new Uint8Array(data);
    this.recvBuffer = concatU8(this.recvBuffer, bytes);

    if (this.recvBuffer.length > MAX_RECV_BUF) {
      console.error('[recv] buffer overflow');
      await this.shutdown('recv-buffer-overflow');
      return;
    }

    while (true) {
      let parsed: { frame: ParsedFrame; consumed: number } | null;
      try {
        parsed = parseFrame(this.recvBuffer);
      } catch (err) {
        console.error('[parse]', err);
        await this.shutdown('parse-error');
        return;
      }

      if (!parsed) break;

      // Guard against zero-progress loops.
      if (parsed.consumed === 0) {
        console.error('[parse] zero-length frame');
        await this.shutdown('zero-length-frame');
        return;
      }

      this.recvBuffer = this.recvBuffer.subarray(parsed.consumed);
      await this.handleFrame(parsed.frame);
    }
  }

  // ============================================================
  // Frame handler
  // ============================================================
  private async handleFrame(frame: ParsedFrame): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    // ---- Pre-handshake: HELLO only ----
    if (!this.handshakeDone) {
      if (frame.type !== FrameType.HELLO) {
        this.sendIfOpen(buildClose(0, ERR_BAD_HELLO));
        throw new Error('Expected HELLO first');
      }

      const nonce = frame.nonce;
      if (!nonce || nonce.length !== EXPECTED_NONCE_LEN) {
        this.sendIfOpen(buildClose(0, ERR_BAD_HELLO));
        throw new Error(`Bad HELLO nonce length: ${nonce?.length}`);
      }

      const welcome = await buildWelcome(nonce, this.secret!);
      this.sendIfOpen(welcome);
      this.handshakeDone = true;
      return;
    }

    // ---- Post-handshake dispatch ----
    switch (frame.type) {
      case FrameType.OPEN: {
        if (this.streams.size >= MAX_STREAMS) {
          this.sendIfOpen(buildClose(frame.streamId!, ERR_TOO_MANY_STREAMS));
          break;
        }
        await this.openStream(frame.streamId!, frame.dcId!);
        break;
      }

      case FrameType.DATA: {
        const sid = frame.streamId!;
        const s = this.streams.get(sid);
        if (!s) break;

        const payload = dataPayload(frame);

        if (payload.length > s.windowSize) {
          await this.closeStream(sid, ERR_WINDOW_EXCEEDED);
          break;
        }
        s.windowSize -= payload.length;

        try {
          await s.writer.write(payload);
        } catch (err) {
          console.error('[tcp-w]', sid, err);
          await this.closeStream(sid, ERR_TCP_WRITE);
        }
        break;
      }

      case FrameType.CLOSE:
        await this.closeStream(frame.streamId!, 0);
        break;

      case FrameType.PING:
        this.sendIfOpen(buildPong());
        break;

      case FrameType.WINDOW: {
        // Peer granted us additional send credit for this stream.
        const sid = frame.streamId!;
        const win = frame.windowSize;
        const s = this.streams.get(sid);
        if (s && typeof win === 'number' && win >= 0) {
          s.windowSize += win;
        }
        break;
      }

      case FrameType.PONG:
      case FrameType.WELCOME:
      default:
        // Silently ignore unexpected frames.
        break;
    }
  }

  // ============================================================
  // Open a TCP stream to a Telegram DC
  // ============================================================
  private async openStream(streamId: number, dcId: number): Promise<void> {
    const addr = DC_ADDRESSES[dcId];
    if (!addr) {
      this.sendIfOpen(buildClose(streamId, ERR_UNKNOWN_DC));
      return;
    }

    let socket: Socket;
    try {
      socket = connect({ hostname: addr, port: DC_PORT });
    } catch (err) {
      console.error('[tcp-c]', streamId, err);
      this.sendIfOpen(buildClose(streamId, ERR_TCP_CONNECT));
      return;
    }

    const writer = socket.writable.getWriter();
    const reader = socket.readable.getReader();

    const stream: Stream = {
      socket,
      writer,
      reader,
      windowSize: INITIAL_WINDOW,
      openedAt: Date.now(),
    };
    this.streams.set(streamId, stream);
    console.log(`[stream-open] #${streamId} -> ${addr}:${DC_PORT}`);

    // ---- TCP -> WebSocket read loop ----
    (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value && value.length > 0) {
            this.sendIfOpen(buildData(streamId, value));
          }
        }
      } catch (err) {
        console.error('[tcp-r]', streamId, err);
      } finally {
        if (this.streams.get(streamId) === stream) {
          this.streams.delete(streamId);
          this.sendIfOpen(buildClose(streamId, 0));
          console.log(`[stream-close] #${streamId}`);
        }
        try { await writer.close(); } catch {}
        try { reader.releaseLock(); } catch {}
      }
    })();
  }

  // ============================================================
  // Close one stream
  // ============================================================
  private async closeStream(streamId: number, code: number): Promise<void> {
    const s = this.streams.get(streamId);
    if (!s) return;
    this.streams.delete(streamId);

    try { await s.writer.close(); } catch {}
    try { await s.reader.cancel(); } catch {}

    this.sendIfOpen(buildClose(streamId, code));
  }

  // ============================================================
  // Full shutdown (WebSocket + all streams)
  // ============================================================
  private async shutdown(reason: string): Promise<void> {
    if (!this.alive) return;
    this.alive = false;
    console.log(`[shutdown] ${reason}`);

    for (const [, s] of this.streams) {
      try { await s.writer.close(); } catch {}
      try { await s.reader.cancel(); } catch {}
    }
    this.streams.clear();

    if (this.ws) {
      try { this.ws.close(1000, reason.slice(0, 120)); } catch {}
      this.ws = null;
    }

    this.handshakeDone = false;
    this.recvBuffer    = new Uint8Array(0);
  }

  // ============================================================
  // Helper: send only if the WebSocket is still open
  // ============================================================
  private sendIfOpen(data: Uint8Array | ArrayBuffer): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(data); } catch {}
    }
  }
}

// ============================================================
// Utility: allocate a fresh Uint8Array with both parts appended.
// Always returns a new buffer — never aliases the inputs.
// ============================================================
function concatU8(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

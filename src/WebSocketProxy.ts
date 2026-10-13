// ============================================================
// Telegram WEB Proxy v1 – Durable Object Session Handler
// Bridges WebSocket (client) ↔ TCP (Telegram DC)
// ============================================================

import { connect } from 'cloudflare:sockets';
import {
  FrameType, parseFrame, buildWelcome, buildData,
  buildClose, buildPong, dataPayload, decodeSecret,
  DC_ADDRESSES, DC_PORT,
  type ParsedFrame,
} from './protocol';

type Socket = ReturnType<typeof connect>;

// ⚠️ Must match NONCE_LEN in protocol.ts
const EXPECTED_NONCE_LEN = 16;

const INITIAL_WINDOW = 1 << 20;          // 1 MiB
const MAX_STREAMS    = 8;                // ← BUG #3: cap concurrent streams
const PING_TIMEOUT_MS = 30_000;          // ← BUG #4: half-open detection
const MAX_RECV_BUF   = 4 << 20;          // 4 MiB safety valve for recvBuffer

interface Env {
  // Future bindings (analytics, KV, etc.)
}

interface Stream {
  socket: Socket;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  windowSize: number;
  lastPingAt: number;                    // ← BUG #4
}

export class WebSocketProxy implements DurableObject {
  private state: DurableObjectState;
  private env: Env;

  private ws: WebSocket | null = null;
  private secret: Uint8Array | null = null;
  private handshakeDone = false;
  private streams = new Map<number, Stream>();
  private recvBuffer: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  private alive = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null; // ← BUG #4

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env   = env;
  }

  // ============================================================
  // Entry point – WebSocket upgrade
  // ============================================================
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }
    // BUG #9 (defensive – Workers runtime also validates)
    if (!request.headers.get('Sec-WebSocket-Key')) {
      return new Response('Missing Sec-WebSocket-Key', { status: 400 });
    }

    const url = new URL(request.url);
    const secretHex = url.searchParams.get('secret');
    if (!secretHex) return new Response('Missing secret', { status: 400 });

    let secret: Uint8Array;
    try {
      secret = decodeSecret(secretHex);
    } catch {
      return new Response('Invalid secret', { status: 400 });
    }

    // Tear down any previous session
    if (this.alive) {
      await this.shutdown('replaced');
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
      this.onClientMessage(ev.data as ArrayBuffer).catch((err) => {
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

    // BUG #4: start the PING watchdog
    this.startPingWatchdog();

    return new Response(null, { status: 101, webSocket: client });
  }

  // ============================================================
  // PING watchdog – close streams / session if the peer goes silent
  // ============================================================
  private startPingWatchdog(): void {
    this.stopPingWatchdog();
    this.pingTimer = setInterval(() => {
      if (!this.alive) return;
      const now = Date.now();
      for (const [sid, s] of this.streams) {
        if (now - s.lastPingAt > PING_TIMEOUT_MS) {
          console.warn(`[watchdog] stream ${sid} timed out`);
          this.closeStream(sid, 0xDEAD).catch(() => {});
        }
      }
      // If WS itself is dead but we haven't noticed, force shutdown
      if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
        this.shutdown('ws-stale').catch(() => {});
      }
    }, PING_TIMEOUT_MS / 2);
  }

  private stopPingWatchdog(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  // ============================================================
  // Inbound buffering & frame dispatch
  // ============================================================
  private async onClientMessage(data: ArrayBuffer): Promise<void> {
    const bytes = new Uint8Array(data);
    this.recvBuffer = concatU8(this.recvBuffer, bytes);

    // Safety: if the buffer grows past the cap, something is wrong
    if (this.recvBuffer.length > MAX_RECV_BUF) {
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

      // BUG #1 FIX: guard against zero-progress
      if (parsed.consumed === 0) {
        console.error('[parse] zero-length frame – aborting');
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

    // ---- Pre-handshake ----
    if (!this.handshakeDone) {
      if (frame.type !== FrameType.HELLO) {
        // BUG #7 FIX: send a protocol CLOSE before the WS-level close
        this.sendIfOpen(buildClose(0, 0x01));  // 0x01 = "bad hello"
        throw new Error('Expected HELLO first');
      }

      const nonce = frame.nonce;
      if (!nonce || nonce.length !== EXPECTED_NONCE_LEN) {
        this.sendIfOpen(buildClose(0, 0x01));
        throw new Error(`Bad nonce length: ${nonce?.length}`);
      }

      const welcome = await buildWelcome(nonce, this.secret!);
      this.sendIfOpen(welcome);
      this.handshakeDone = true;
      return;
    }

    // ---- Post-handshake dispatch ----
    switch (frame.type) {

      case FrameType.OPEN: {
        // BUG #3 FIX: enforce max streams
        if (this.streams.size >= MAX_STREAMS) {
          this.sendIfOpen(buildClose(frame.streamId!, 0x04)); // "too many streams"
          break;
        }
        await this.openStream(frame.streamId!, frame.dcId!);
        break;
      }

      case FrameType.DATA: {
        const sid = frame.streamId!;
        const s   = this.streams.get(sid);
        if (!s) break;

        const payload = dataPayload(frame);

        if (payload.length > s.windowSize) {
          await this.closeStream(sid, 0x02); // "window exceeded"
          break;
        }
        s.windowSize -= payload.length;

        try {
          await s.writer.write(payload);
        } catch (err) {
          console.error('[tcp-w]', sid, err);
          await this.closeStream(sid, 0x03);
        }
        break;
      }

      case FrameType.CLOSE:
        await this.closeStream(frame.streamId!, 0x00);
        break;

      case FrameType.PING: {
        // BUG #6 FIX: guard + update watchdog timestamp
        for (const s of this.streams.values()) s.lastPingAt = Date.now();
        this.sendIfOpen(buildPong());
        break;
      }

      case FrameType.WINDOW: {
        // BUG #5 FIX: actually apply the window update
        const sid  = frame.streamId!;
        const win  = (frame as any).windowSize as number; // adjust to protocol type
        const s    = this.streams.get(sid);
        if (s && typeof win === 'number' && win >= 0) {
          s.windowSize += win;
        }
        break;
      }

      case FrameType.PONG:
      case FrameType.WELCOME:
      default:
        break;
    }
  }

  // ============================================================
  // Open a TCP stream to a Telegram DC
  // ============================================================
  private async openStream(streamId: number, dcId: number): Promise<void> {
    const addr = DC_ADDRESSES[dcId];
    if (!addr) {
      this.sendIfOpen(buildClose(streamId, 0x05)); // unknown DC
      return;
    }

    let socket: Socket;
    try {
      socket = connect({ hostname: addr, port: DC_PORT });
    } catch (err) {
      console.error('[tcp-c]', streamId, err);
      this.sendIfOpen(buildClose(streamId, 0x06));
      return;
    }

    const writer = socket.writable.getWriter();
    const reader = socket.readable.getReader();

    const stream: Stream = {
      socket,
      writer,
      reader,
      windowSize: INITIAL_WINDOW,
      lastPingAt: Date.now(),
    };
    this.streams.set(streamId, stream);
    console.log(`[stream] opened #${streamId} → ${addr}:${DC_PORT}`);

    // TCP → WS read loop
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
        // Only clean up if we're still the owner of this slot
        if (this.streams.get(streamId) === stream) {
          this.streams.delete(streamId);
          this.sendIfOpen(buildClose(streamId, 0x00));
          console.log(`[stream] closed #${streamId}`);
        }
        // BUG #2 FIX: close the writable side so the remote gets a FIN
        try { stream.writer.close(); } catch {}
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
    try { await s.reader.cancel();  } catch {}
    try { s.reader.releaseLock();  } catch {}

    this.sendIfOpen(buildClose(streamId, code));
  }

  // ============================================================
  // Full shutdown
  // ============================================================
  private async shutdown(reason: string): Promise<void> {
    if (!this.alive) return;
    this.alive = false;
    console.log(`[shutdown] ${reason}`);

    this.stopPingWatchdog();

    for (const [, s] of this.streams) {
      try { await s.writer.close(); } catch {}
      try { await s.reader.cancel();  } catch {}
      try { s.reader.releaseLock();  } catch {}
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
  // Helper
  // ============================================================
  private sendIfOpen(data: Uint8Array | ArrayBuffer): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(data); } catch {}
    }
  }
}

// ============================================================
// concatU8 – O(n) append, returns a fresh ArrayBuffer-backed view
// ============================================================
function concatU8(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  if (a.length === 0) return b as Uint8Array<ArrayBuffer>;
  if (b.length === 0) return a as Uint8Array<ArrayBuffer>;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

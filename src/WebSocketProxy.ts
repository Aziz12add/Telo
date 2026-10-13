// ============================================================
// Telegram WEB Proxy v1 - Durable Object Session Handler
// Bridges WebSocket (from client) <-> TCP (to Telegram DC)
// ============================================================

import { connect } from 'cloudflare:sockets';
import {
  FrameType, parseFrame, buildWelcome, buildData,
  buildClose, buildPong, dataPayload, decodeSecret,
  DC_ADDRESSES, DC_PORT,
  type ParsedFrame,
} from './protocol';

// Socket type derived from connect() return type.
// (cloudflare:sockets does not export "Socket" as a named type.)
type Socket = ReturnType<typeof connect>;

// ⚠️ Must match NONCE_LEN in protocol.ts
const EXPECTED_NONCE_LEN = 16;

// Initial per-stream send window (1 MiB)
const INITIAL_WINDOW = 1 << 20;

interface Env {
  // Future bindings can be added here (analytics, KV, etc.)
}

interface Stream {
  socket: Socket;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  windowSize: number;
}

export class WebSocketProxy implements DurableObject {
  private state: DurableObjectState;
  private env: Env;

  // ---- Per-connection state ----
  private ws: WebSocket | null = null;
  private secret: Uint8Array | null = null;
  private handshakeDone = false;
  private streams = new Map<number, Stream>();
  private recvBuffer = new Uint8Array(0);
  private alive = false;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  // ============================================================
  // Entry point: handle WebSocket upgrade
  // ============================================================
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
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

    // Close any stale session cleanly before starting a new one
    if (this.alive) {
      await this.shutdown('replaced by new session');
    }

    this.secret = secret;
    this.handshakeDone = false;
    this.streams = new Map();
    this.recvBuffer = new Uint8Array(0);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    this.ws = server;
    this.alive = true;

    server.addEventListener('message', (ev) => {
      this.onClientMessage(ev.data).catch((err) => {
        console.error('client message error:', err);
        this.shutdown('client error').catch(() => {});
      });
    });

    server.addEventListener('close', () => {
      this.shutdown('ws closed').catch(() => {});
    });

    server.addEventListener('error', () => {
      this.shutdown('ws error').catch(() => {});
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  // ============================================================
  // Inbound message buffering and frame dispatch
  // ============================================================
  private async onClientMessage(data: ArrayBuffer | string): Promise<void> {
    const bytes = typeof data === 'string'
      ? new TextEncoder().encode(data)
      : new Uint8Array(data);

    this.recvBuffer = concatU8(this.recvBuffer, bytes);

    while (true) {
      let parsed: { frame: ParsedFrame; consumed: number } | null;
      try {
        parsed = parseFrame(this.recvBuffer);
      } catch (err) {
        console.error('frame parse error:', err);
        await this.shutdown('parse error');
        return;
      }

      if (!parsed) break;

      this.recvBuffer = this.recvBuffer.subarray(parsed.consumed);
      await this.handleFrame(parsed.frame);
    }
  }

  // ============================================================
  // Frame handler (pre- and post-handshake)
  // ============================================================
  private async handleFrame(frame: ParsedFrame): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    // ---- Pre-handshake: only HELLO is allowed ----
    if (!this.handshakeDone) {
      if (frame.type !== FrameType.HELLO) {
        throw new Error('Expected HELLO first');
      }
      const nonce = frame.nonce;
      if (!nonce || nonce.length !== EXPECTED_NONCE_LEN) {
        throw new Error(`Invalid HELLO nonce length: ${nonce?.length}`);
      }
      const welcome = await buildWelcome(nonce, this.secret!);
      this.ws.send(welcome);
      this.handshakeDone = true;
      return;
    }

    // ---- Post-handshake: dispatch by frame type ----
    switch (frame.type) {
      case FrameType.OPEN:
        await this.openStream(frame.streamId!, frame.dcId!);
        break;

      case FrameType.DATA: {
        const sid = frame.streamId!;
        const s = this.streams.get(sid);
        if (!s) break;

        const payload = dataPayload(frame);

        // Backpressure check
        if (payload.length > s.windowSize) {
          await this.closeStream(sid, 0xFFFFFFFF);
          break;
        }
        s.windowSize -= payload.length;

        try {
          await s.writer.write(payload);
        } catch (err) {
          console.error('tcp write failed', sid, err);
          await this.closeStream(sid, 1);
        }
        break;
      }

      case FrameType.CLOSE:
        await this.closeStream(frame.streamId!, 0);
        break;

      case FrameType.PING:
        this.ws.send(buildPong());
        break;

      case FrameType.WINDOW:
      case FrameType.PONG:
      case FrameType.WELCOME:
      default:
        // Not handled in this minimal implementation
        break;
    }
  }

  // ============================================================
  // TCP bridge: open a new stream to a Telegram DC
  // ============================================================
  private async openStream(streamId: number, dcId: number): Promise<void> {
    const addr = DC_ADDRESSES[dcId];
    if (!addr) {
      this.ws!.send(buildClose(streamId, 2));
      return;
    }

    let socket: Socket;
    try {
      socket = connect({ hostname: addr, port: DC_PORT });
    } catch (err) {
      console.error('socket connect failed', streamId, err);
      this.ws!.send(buildClose(streamId, 3));
      return;
    }

    const writer = socket.writable.getWriter();
    const reader = socket.readable.getReader();

    const stream: Stream = {
      socket,
      writer,
      reader,
      windowSize: INITIAL_WINDOW,
    };
    this.streams.set(streamId, stream);

    // TCP -> WebSocket read loop
    (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value && value.length > 0) {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
              this.ws.send(buildData(streamId, value));
            }
          }
        }
      } catch (err) {
        console.error('tcp read error', streamId, err);
      } finally {
        // Only clean up if this is still the active stream for this id
        if (this.streams.get(streamId) === stream) {
          this.streams.delete(streamId);
          try { this.ws?.send(buildClose(streamId, 0)); } catch {}
        }
        try { reader.releaseLock(); } catch {}
      }
    })();
  }

  // ============================================================
  // Close a single stream
  // ============================================================
  private async closeStream(streamId: number, code: number): Promise<void> {
    const s = this.streams.get(streamId);
    if (!s) return;
    this.streams.delete(streamId);

    try { await s.writer.close(); } catch {}
    try { await s.reader.cancel(); } catch {}

    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(buildClose(streamId, code));
      }
    } catch {}
  }

  // ============================================================
  // Full shutdown (WebSocket + all streams)
  // ============================================================
  private async shutdown(reason: string): Promise<void> {
    if (!this.alive) return;
    this.alive = false;
    console.log('shutting down:', reason);

    for (const [, s] of this.streams) {
      try { await s.writer.close(); } catch {}
      try { await s.reader.cancel(); } catch {}
    }
    this.streams.clear();

    if (this.ws) {
      try { this.ws.close(1000, reason); } catch {}
      this.ws = null;
    }

    this.handshakeDone = false;
    this.recvBuffer = new Uint8Array(0);
  }
}

// ============================================================
// Utility: concatenate two Uint8Arrays
// Explicit ArrayBuffer return type to satisfy TS 5.7+ generics.
// ============================================================
function concatU8(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

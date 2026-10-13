import { connect, type Socket } from 'cloudflare:sockets';
import {
  FrameType, parseFrame, buildWelcome, buildData,
  buildClose, buildPong, dataPayload, decodeSecret,
  DC_ADDRESSES, DC_PORT,
  type ParsedFrame,
} from './protocol';

// ⚠️ این باید هم‌خوان با NONCE_LEN در protocol.ts باشد
const EXPECTED_NONCE_LEN = 16;

interface Env {}

interface Stream {
  socket: Socket;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  windowSize: number;
}

export class WebSocketProxy implements DurableObject {
  private state: DurableObjectState;
  private env: Env;

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

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
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

    // اگر session قبلی زنده است، آن را تمیز ببند
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

  private async onClientMessage(data: ArrayBuffer | string): Promise<void> {
    const bytes = typeof data === 'string'
      ? new TextEncoder().encode(data)
      : new Uint8Array(data);

    this.recvBuffer = concatU8(this.recvBuffer, bytes);

    while (true) {
      let parsed;
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

  private async handleFrame(frame: ParsedFrame): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    // ---- Pre-handshake: only HELLO ----
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

    switch (frame.type) {
      case FrameType.OPEN:
        await this.openStream(frame.streamId!, frame.dcId!);
        break;

      case FrameType.DATA: {
        const sid = frame.streamId!;
        const s = this.streams.get(sid);
        if (!s) break;

        const payload = dataPayload(frame);
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
      default:
        break;
    }
  }

  private async openStream(streamId: number, dcId: number): Promise<void> {
    const addr = DC_ADDRESSES[dcId];
    if (!addr) {
      this.ws!.send(buildClose(streamId, 2));
      return;
    }

    let socket: Socket;
    try {
      socket = connect({ hostname: addr, port: DC_PORT });
    } catch (e) {
      this.ws!.send(buildClose(streamId, 3));
      return;
    }

    const writer = socket.writable.getWriter();
    const reader = socket.readable.getReader();

    const stream: Stream = {
      socket, writer, reader,
      windowSize: 1 << 20,
    };
    this.streams.set(streamId, stream);

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
        if (this.streams.get(streamId) === stream) {
          this.streams.delete(streamId);
          try { this.ws?.send(buildClose(streamId, 0)); } catch {}
        }
        try { reader.releaseLock(); } catch {}
      }
    })();
  }

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

function concatU8(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

import {
  FrameType, parseFrame, buildHello, buildWelcome, buildData,
  buildClose, buildPong, buildWindow, dataPayload, decodeSecret,
  DC_ADDRESSES, DC_PORT,
} from './protocol';

interface Env {
  // Could add bindings later (e.g., analytics)
}

interface Stream {
  socket: Socket;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  windowSize: number;
}

export class WebSocketProxy implements DurableObject {
  state: DurableObjectState;
  env: Env;

  // Per-connection state
  private ws: WebSocket | null = null;
  private secret: Uint8Array | null = null;
  private handshakeDone = false;
  private clientNonce: Uint8Array | null = null;
  private streams = new Map<number, Stream>();
  private recvBuffer = new Uint8Array(0);

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const upgrade = request.headers.get('Upgrade');
    if (upgrade !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    // Extract secret from URL: /apiws?secret=<32hex>
    const url = new URL(request.url);
    const secretHex = url.searchParams.get('secret');
    if (!secretHex) {
      return new Response('Missing secret', { status: 400 });
    }
    try {
      this.secret = decodeSecret(secretHex);
    } catch {
      return new Response('Invalid secret', { status: 400 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    this.ws = server;

    // Reset state (DO is single-connection here)
    this.handshakeDone = false;
    this.clientNonce = null;
    this.streams.clear();
    this.recvBuffer = new Uint8Array(0);

    server.addEventListener('message', (ev) => {
      this.onClientMessage(ev.data).catch((err) => {
        console.error('client message error:', err);
        try { server.close(1011, 'internal error'); } catch {}
      });
    });

    server.addEventListener('close', () => this.cleanup());
    server.addEventListener('error', () => this.cleanup());

    return new Response(null, { status: 101, webSocket: client });
  }

  // ============================================================
  // Client → Server
  // ============================================================
  private async onClientMessage(data: ArrayBuffer | string): Promise<void> {
    const bytes = typeof data === 'string'
      ? new TextEncoder().encode(data)
      : new Uint8Array(data);

    // Append to receive buffer
    this.recvBuffer = concatU8(this.recvBuffer, bytes);

    // Parse as many frames as we can
    while (true) {
      const parsed = parseFrame(this.recvBuffer);
      if (!parsed) break;
      this.recvBuffer = this.recvBuffer.subarray(parsed.consumed);
      await this.handleFrame(parsed.frame);
    }
  }

  private async handleFrame(frame: ReturnType<typeof parseFrame> extends infer T
    ? T extends { frame: infer F } ? F : never : never): Promise<void> {
    if (!this.handshakeDone) {
      // Only HELLO allowed before handshake
      if (frame.type !== FrameType.HELLO) {
        throw new Error('Expected HELLO first');
      }
      this.clientNonce = frame.nonce ?? null;
      if (!this.clientNonce || this.clientNonce.length !== 32) {
        throw new Error('Invalid HELLO nonce');
      }
      const welcome = await buildWelcome(this.clientNonce, this.secret!);
      this.ws!.send(welcome);
      this.handshakeDone = true;
      return;
    }

    switch (frame.type) {
      case FrameType.OPEN: {
        const sid = frame.streamId!;
        const dc  = frame.dcId!;
        await this.openStream(sid, dc);
        break;
      }
      case FrameType.DATA: {
        const sid = frame.streamId!;
        const s = this.streams.get(sid);
        if (!s) break;
        const payload = dataPayload(frame);
        if (payload.length > s.windowSize) {
          // Backpressure violation; close stream
          await this.closeStream(sid, 0xFFFFFFFF);
          break;
        }
        s.windowSize -= payload.length;
        try {
          await s.writer.write(payload);
        } catch (e) {
          await this.closeStream(sid, 1);
        }
        break;
      }
      case FrameType.CLOSE: {
        await this.closeStream(frame.streamId!, 0);
        break;
      }
      case FrameType.PING: {
        this.ws!.send(buildPong());
        break;
      }
      case FrameType.WINDOW: {
        // Client is granting us send window (not used in this minimal impl)
        break;
      }
      default:
        // WELCOME/PONG from client: ignore
        break;
    }
  }

  // ============================================================
  // TCP ↔ WebSocket Bridging
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
    } catch (e) {
      this.ws!.send(buildClose(streamId, 3));
      return;
    }

    const writer = socket.writable.getWriter();
    const reader = socket.readable.getReader();

    const stream: Stream = {
      socket, writer, reader,
      windowSize: 1 << 20, // 1 MiB initial window
    };
    this.streams.set(streamId, stream);

    // Read loop: TCP → WebSocket (as DATA frames)
    (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value && value.length > 0) {
            this.ws!.send(buildData(streamId, value));
          }
        }
      } catch (e) {
        console.error('tcp read error', streamId, e);
      } finally {
        this.streams.delete(streamId);
        try { this.ws!.send(buildClose(streamId, 0)); } catch {}
        try { socket.close(); } catch {}
      }
    })();
  }

  private async closeStream(streamId: number, code: number): Promise<void> {
    const s = this.streams.get(streamId);
    if (!s) return;
    this.streams.delete(streamId);
    try { await s.writer.close(); } catch {}
    try { s.socket.close(); } catch {}
    // Notify client
    try { this.ws!.send(buildClose(streamId, code)); } catch {}
  }

  private cleanup(): void {
    for (const [, s] of this.streams) {
      try { s.socket.close(); } catch {}
    }
    this.streams.clear();
    this.ws = null;
  }
}

// ---- util ----
function concatU8(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

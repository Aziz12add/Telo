/**
 * Telegram Proxy Session Durable Object
 * Handles persistent state, multiplexed streams, window credit flow control,
 * bounded queues, and real TCP connection to Telegram DC via cloudflare:sockets.
 */

// @ts-ignore Cloudflare Workers socket API
import { connect } from 'cloudflare:sockets';
import { TELEGRAM_DCS, DEFAULT_DC, parseMTProxyHandshake, parseSecretHex, Aes256Ctr } from './mtproxy';
import { FRAME_TYPES, encodeFrame, decodeFrames, verifySessionToken } from './protocol';

export interface Env {
  PROXY_SECRET: string;
  SESSIONS: any;
  PUBLIC_HOSTNAME?: string;
  MAX_STREAMS?: string;
  SESSION_TTL_SECONDS?: string;
  DIAGNOSTICS?: string;
}

export class ProxySessionDO {
  private state: any;
  private env: Env;
  private ws: WebSocket | null = null;
  private upstreamSocket: any = null;
  private upstreamWriter: any = null;
  private upstreamReader: any = null;
  private targetDc = DEFAULT_DC;
  private clientIncomingBuffer = new Uint8Array(0);
  private clientDecryptCipher: Aes256Ctr | null = null;
  private clientEncryptCipher: Aes256Ctr | null = null;
  private isHandshakeComplete = false;
  private sessionWindow = 65536; // 64KB initial window credit
  private maxStreams = 16;
  private activeStreams = new Set<number>();
  private closed = false;

  constructor(state: any, env: Env) {
    this.state = state;
    this.env = env;
    if (env.MAX_STREAMS) {
      this.maxStreams = parseInt(env.MAX_STREAMS, 10) || 16;
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      const upgradeHeader = request.headers.get('Upgrade');
      if (upgradeHeader !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }

      // Check auth token
      const token = url.searchParams.get('token');
      const dcParam = parseInt(url.searchParams.get('dc') || '2', 10);
      this.targetDc = TELEGRAM_DCS[dcParam] || DEFAULT_DC;

      if (!token || !(await verifySessionToken(this.env.PROXY_SECRET, token))) {
        return new Response('Unauthorized session token', { status: 401 });
      }

      // @ts-ignore
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

      // @ts-ignore Cloudflare WebSocket server.accept()
      server.accept();
      this.ws = server;
      this.setupWebSocket(server);

      return new Response(null, {
        status: 101,
        // @ts-ignore
        webSocket: client
      });
    }

    if (url.pathname === '/stats') {
      return new Response(JSON.stringify({
        activeStreams: this.activeStreams.size,
        targetDc: this.targetDc.name,
        isHandshakeComplete: this.isHandshakeComplete,
        window: this.sessionWindow
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response('Not found', { status: 404 });
  }

  private setupWebSocket(ws: WebSocket) {
    ws.addEventListener('message', async (event: MessageEvent) => {
      try {
        let chunk: Uint8Array;
        if (typeof event.data === 'string') {
          chunk = new TextEncoder().encode(event.data);
        } else if (event.data instanceof ArrayBuffer) {
          chunk = new Uint8Array(event.data);
        } else {
          chunk = new Uint8Array(await (event.data as Blob).arrayBuffer());
        }

        await this.handleIncomingClientBytes(chunk);
      } catch (err: any) {
        this.closeSession('Error handling client message: ' + err.message);
      }
    });

    ws.addEventListener('close', () => {
      this.closeSession('Client WebSocket closed');
    });

    ws.addEventListener('error', (err) => {
      this.closeSession('WebSocket error');
    });
  }

  private async handleIncomingClientBytes(chunk: Uint8Array) {
    // Append to incoming buffer
    const next = new Uint8Array(this.clientIncomingBuffer.byteLength + chunk.byteLength);
    next.set(this.clientIncomingBuffer, 0);
    next.set(chunk, this.clientIncomingBuffer.byteLength);
    this.clientIncomingBuffer = next;

    // Check if this is framed bridge protocol or raw MTProxy stream
    if (this.clientIncomingBuffer.length >= 8 && this.clientIncomingBuffer[0] <= 0x0f) {
      // Decode framed binary protocol
      const { frames, remainder } = decodeFrames(this.clientIncomingBuffer);
      this.clientIncomingBuffer = remainder;

      for (const frame of frames) {
        await this.handleBridgeFrame(frame);
      }
      return;
    }

    // Otherwise, handle raw MTProxy TCP handshake
    if (!this.isHandshakeComplete) {
      if (this.clientIncomingBuffer.length < 64) {
        return; // wait for full 64 bytes
      }

      const raw64 = this.clientIncomingBuffer.slice(0, 64);
      const secretBytes = parseSecretHex(this.env.PROXY_SECRET);
      const handshake = await parseMTProxyHandshake(raw64, secretBytes);

      if (!handshake || !handshake.valid) {
        this.closeSession('Invalid MTProxy client handshake');
        return;
      }

      this.clientDecryptCipher = handshake.clientDecryptCipher;
      this.clientEncryptCipher = handshake.clientEncryptCipher;
      this.targetDc = handshake.upstreamDc;
      this.isHandshakeComplete = true;

      // Connect upstream to Telegram DC via cloudflare:sockets
      await this.connectUpstream();

      // Write handshake packet upstream
      if (this.upstreamWriter) {
        await this.upstreamWriter.write(handshake.upstreamHandshakePacket);
      }

      // Process any remaining bytes after the initial 64-byte handshake
      const leftover = this.clientIncomingBuffer.slice(64);
      this.clientIncomingBuffer = new Uint8Array(0);

      if (leftover.length > 0 && this.clientDecryptCipher && this.upstreamWriter) {
        const decrypted = await this.clientDecryptCipher.process(leftover);
        await this.upstreamWriter.write(decrypted);
      }
    } else {
      // Subsequent data: decrypt and write upstream
      const data = this.clientIncomingBuffer;
      this.clientIncomingBuffer = new Uint8Array(0);

      if (this.clientDecryptCipher && this.upstreamWriter) {
        const decrypted = await this.clientDecryptCipher.process(data);
        await this.upstreamWriter.write(decrypted);
      }
    }
  }

  private async handleBridgeFrame(frame: any) {
    switch (frame.type) {
      case FRAME_TYPES.HELLO: {
        // Welcome frame back with initial window
        const welcomePayload = new Uint8Array(8);
        const view = new DataView(welcomePayload.buffer);
        view.setUint32(0, this.sessionWindow, false);
        view.setUint32(4, this.maxStreams, false);

        this.sendFrame(FRAME_TYPES.WELCOME, 0, 0, welcomePayload);
        await this.connectUpstream();
        break;
      }

      case FRAME_TYPES.DATA: {
        if (!this.upstreamWriter) {
          await this.connectUpstream();
        }
        if (this.upstreamWriter && frame.payload.byteLength > 0) {
          await this.upstreamWriter.write(frame.payload);
        }
        break;
      }

      case FRAME_TYPES.WINDOW_UPDATE: {
        const view = new DataView(frame.payload.buffer, frame.payload.byteOffset, 4);
        const credit = view.getUint32(0, false);
        this.sessionWindow = Math.min(this.sessionWindow + credit, 1048576); // max 1MB
        break;
      }

      case FRAME_TYPES.PING: {
        this.sendFrame(FRAME_TYPES.PONG, frame.streamId, 0, frame.payload);
        break;
      }

      case FRAME_TYPES.CLOSE: {
        this.activeStreams.delete(frame.streamId);
        break;
      }
    }
  }

  private sendFrame(type: number, streamId: number, flags: number, payload: Uint8Array) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const encoded = encodeFrame(type, streamId, flags, payload);
      this.ws.send(encoded);
    }
  }

  private async connectUpstream() {
    if (this.upstreamSocket) return;

    try {
      this.upstreamSocket = connect({
        hostname: this.targetDc.ip,
        port: this.targetDc.port
      });

      this.upstreamWriter = this.upstreamSocket.writable.getWriter();
      this.upstreamReader = this.upstreamSocket.readable.getReader();

      // Read continuously from Telegram DC and forward downstream to client
      this.pumpUpstreamToClient();
    } catch (err: any) {
      this.closeSession('Failed to connect to Telegram DC: ' + err.message);
    }
  }

  private async pumpUpstreamToClient() {
    try {
      while (!this.closed && this.upstreamReader) {
        const { value, done } = await this.upstreamReader.read();
        if (done) break;

        if (value && value.byteLength > 0) {
          if (this.clientEncryptCipher) {
            // Encrypt and forward raw bytes
            const encrypted = await this.clientEncryptCipher.process(value);
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
              this.ws.send(encrypted);
            }
          } else {
            // Forward framed data
            this.sendFrame(FRAME_TYPES.DATA, 1, 0, value);
          }
        }
      }
    } catch {
      // Upstream closed
    } finally {
      this.closeSession('Upstream finished');
    }
  }

  private closeSession(reason: string) {
    if (this.closed) return;
    this.closed = true;

    try {
      if (this.upstreamWriter) this.upstreamWriter.close();
      if (this.upstreamReader) this.upstreamReader.cancel();
      if (this.upstreamSocket) this.upstreamSocket.close();
    } catch {}

    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.close(1000, reason);
      }
    } catch {}
  }
}

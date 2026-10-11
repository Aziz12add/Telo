// session.js
// Cloudflare Durable Object ProxySessionDO for Telegram Web Proxy v1

import { connect } from 'cloudflare:sockets';
import {
  FRAME_TYPES,
  encodeFrame,
  decodeFrames,
  verifySessionToken,
  parseSecret,
} from './protocol.js';

export const TELEGRAM_DCS = Object.freeze({
  1: { ip: '149.154.175.50', port: 443 },
  2: { ip: '149.154.167.51', port: 443 },
  3: { ip: '149.154.175.100', port: 443 },
  4: { ip: '149.154.167.91', port: 443 },
  5: { ip: '91.108.56.165', port: 443 },
});

export const DEFAULT_DC_IP = '149.154.167.51';
export const DEFAULT_DC_PORT = 443;

const WINDOW_MAX_SIZE = 4 * 1024 * 1024; // 4 MiB flow-control limit
const WINDOW_INITIAL_SIZE = 1 * 1024 * 1024; // 1 MiB initial stream window
const CHUNK_SIZE = 64 * 1024; // 64 KiB chunks for outbound DATA frames
const MAX_CONCURRENT_STREAMS = 32;

class StreamSession {
  /**
   * @param {number} streamId
   * @param {string} targetIp
   * @param {number} targetPort
   * @param {ProxySessionDO} parent
   */
  constructor(streamId, targetIp, targetPort, parent) {
    this.streamId = streamId;
    this.targetIp = targetIp;
    this.targetPort = targetPort;
    this.parent = parent;

    this.socket = null;
    this.writer = null;
    this.reader = null;

    this.closed = false;
    this.egressWindow = WINDOW_INITIAL_SIZE; // Client's available receive credit for this stream
    this.ingressWindow = WINDOW_MAX_SIZE;   // Our remaining allowance for incoming client data
  }

  async start() {
    try {
      this.socket = connect({
        hostname: this.targetIp,
        port: this.targetPort,
      });

      this.writer = this.socket.writable.getWriter();
      this.reader = this.socket.readable.getReader();

      this.pumpUpstreamToClient();
    } catch (err) {
      this.closeStream(0x01); // Error code
    }
  }

  async writeUpstream(payload) {
    if (this.closed || !this.writer) return;

    try {
      await this.writer.write(payload);

      // Decrement ingress window and refill if below 50%
      this.ingressWindow -= payload.byteLength;
      if (this.ingressWindow <= WINDOW_MAX_SIZE / 2) {
        const credit = WINDOW_MAX_SIZE - this.ingressWindow;
        this.ingressWindow += credit;
        this.parent.sendWindowUpdate(this.streamId, credit);
      }
    } catch {
      this.closeStream(0x02);
    }
  }

  updateEgressWindow(credit) {
    this.egressWindow = Math.min(this.egressWindow + credit, WINDOW_MAX_SIZE);
  }

  async pumpUpstreamToClient() {
    try {
      while (!this.closed && this.reader) {
        const { value, done } = await this.reader.read();
        if (done) break;

        if (value && value.byteLength > 0) {
          let offset = 0;
          while (offset < value.byteLength && !this.closed) {
            const chunkSize = Math.min(CHUNK_SIZE, value.byteLength - offset);
            const chunk = value.subarray(offset, offset + chunkSize);

            this.parent.sendDataFrame(this.streamId, chunk);
            this.egressWindow -= chunkSize;
            offset += chunkSize;

            // Simple wait if client egress window is fully saturated
            if (this.egressWindow <= 0) {
              await this.waitForEgressCredit();
            }
          }
        }
      }
    } catch {
      // Socket ended or reset
    } finally {
      this.closeStream(0x00);
    }
  }

  async waitForEgressCredit() {
    let attempts = 0;
    while (this.egressWindow <= 0 && !this.closed && attempts < 50) {
      await new Promise((r) => setTimeout(r, 20));
      attempts++;
    }
  }

  closeStream(code = 0) {
    if (this.closed) return;
    this.closed = true;

    try {
      if (this.writer) this.writer.close();
      if (this.reader) this.reader.cancel();
      if (this.socket) this.socket.close();
    } catch {
      // Ignored
    }

    this.parent.notifyStreamClosed(this.streamId, code);
  }
}

export class ProxySessionDO {
  /**
   * @param {DurableObjectState} state
   * @param {object} env
   */
  constructor(state, env) {
    this.state = state;
    this.env = env;

    /** @type {WebSocket|null} */
    this.ws = null;
    /** @type {Map<number, StreamSession>} */
    this.streams = new Map();
    /** @type {Uint8Array} */
    this.rxBuffer = new Uint8Array(0);
    this.isSessionAlive = false;
  }

  /**
   * Main Durable Object entry point
   * @param {Request} request
   * @returns {Promise<Response>}
   */
  async fetch(request) {
    const url = new URL(request.url);

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const token = url.searchParams.get('token');
    if (!token) {
      return new Response('Missing session token', { status: 401 });
    }

    const secret = this.env.PROXY_SECRET;
    if (!secret) {
      return new Response('Server configuration error: missing PROXY_SECRET', { status: 500 });
    }

    const auth = await verifySessionToken(secret, token);
    if (!auth.valid) {
      return new Response('Unauthorized token', { status: 403 });
    }

    // @ts-ignore Cloudflare WebSocketPair
    const pair = new WebSocketPair();
    const [clientSocket, serverSocket] = Object.values(pair);

    // @ts-ignore accept server socket
    serverSocket.accept();
    this.ws = serverSocket;
    this.isSessionAlive = true;

    this.bindWebSocketHandlers(serverSocket);

    return new Response(null, {
      status: 101,
      // @ts-ignore webSocket response binding
      webSocket: clientSocket,
    });
  }

  /**
   * @param {WebSocket} ws
   */
  bindWebSocketHandlers(ws) {
    ws.addEventListener('message', async (event) => {
      try {
        let chunk;
        if (typeof event.data === 'string') {
          chunk = new TextEncoder().encode(event.data);
        } else if (event.data instanceof ArrayBuffer) {
          chunk = new Uint8Array(event.data);
        } else {
          chunk = new Uint8Array(await event.data.arrayBuffer());
        }

        this.appendRxChunk(chunk);
        await this.processFrames();
      } catch (err) {
        this.closeAll('Frame decoding error');
      }
    });

    ws.addEventListener('close', () => {
      this.closeAll('Client disconnected');
    });

    ws.addEventListener('error', () => {
      this.closeAll('WebSocket error');
    });
  }

  /**
   * @param {Uint8Array} chunk
   */
  appendRxChunk(chunk) {
    const next = new Uint8Array(this.rxBuffer.byteLength + chunk.byteLength);
    next.set(this.rxBuffer, 0);
    next.set(chunk, this.rxBuffer.byteLength);
    this.rxBuffer = next;
  }

  async processFrames() {
    if (this.rxBuffer.byteLength === 0) return;

    const { frames, remainder } = decodeFrames(this.rxBuffer);
    this.rxBuffer = remainder;

    for (const frame of frames) {
      await this.handleFrame(frame);
    }
  }

  /**
   * Dispatches and processes an individual protocol frame
   * @param {{ type: number, streamId: number, flags: number, payload: Uint8Array }} frame
   */
  async handleFrame(frame) {
    switch (frame.type) {
      case FRAME_TYPES.HELLO: {
        // Send WELCOME frame back to client
        const welcomePayload = new Uint8Array(8);
        const view = new DataView(welcomePayload.buffer);
        view.setUint32(0, WINDOW_INITIAL_SIZE, false);
        view.setUint32(4, MAX_CONCURRENT_STREAMS, false);

        this.sendRawFrame(FRAME_TYPES.WELCOME, 0, 0, welcomePayload);
        break;
      }

      case FRAME_TYPES.OPEN: {
        const streamId = frame.streamId;
        if (this.streams.has(streamId)) {
          return;
        }

        if (this.streams.size >= MAX_CONCURRENT_STREAMS) {
          this.notifyStreamClosed(streamId, 0x03); // Max streams reached
          return;
        }

        // Parse optional target DC from payload: [1B dc_id] or [4B IPv4][2B port]
        let targetIp = DEFAULT_DC_IP;
        let targetPort = DEFAULT_DC_PORT;

        if (frame.payload.byteLength >= 1) {
          const dcId = frame.payload[0];
          if (TELEGRAM_DCS[dcId]) {
            targetIp = TELEGRAM_DCS[dcId].ip;
            targetPort = TELEGRAM_DCS[dcId].port;
          }
        }

        const stream = new StreamSession(streamId, targetIp, targetPort, this);
        this.streams.set(streamId, stream);
        await stream.start();
        break;
      }

      case FRAME_TYPES.DATA: {
        const stream = this.streams.get(frame.streamId);
        if (stream && frame.payload.byteLength > 0) {
          await stream.writeUpstream(frame.payload);
        }
        break;
      }

      case FRAME_TYPES.WINDOW: {
        const stream = this.streams.get(frame.streamId);
        if (stream && frame.payload.byteLength >= 4) {
          const view = new DataView(frame.payload.buffer, frame.payload.byteOffset, 4);
          const credit = view.getUint32(0, false);
          stream.updateEgressWindow(credit);
        }
        break;
      }

      case FRAME_TYPES.PING: {
        this.sendRawFrame(FRAME_TYPES.PONG, frame.streamId, 0, frame.payload);
        break;
      }

      case FRAME_TYPES.PONG: {
        break;
      }

      case FRAME_TYPES.CLOSE: {
        const stream = this.streams.get(frame.streamId);
        if (stream) {
          this.streams.delete(frame.streamId);
          stream.closeStream(0x00);
        }
        break;
      }
    }
  }

  sendDataFrame(streamId, payload) {
    this.sendRawFrame(FRAME_TYPES.DATA, streamId, 0, payload);
  }

  sendWindowUpdate(streamId, credit) {
    const payload = new Uint8Array(4);
    const view = new DataView(payload.buffer);
    view.setUint32(0, credit, false);
    this.sendRawFrame(FRAME_TYPES.WINDOW, streamId, 0, payload);
  }

  notifyStreamClosed(streamId, code = 0) {
    this.streams.delete(streamId);
    const payload = new Uint8Array(1);
    payload[0] = code & 0xff;
    this.sendRawFrame(FRAME_TYPES.CLOSE, streamId, 0, payload);
  }

  sendRawFrame(type, streamId, flags, payload) {
    if (!this.ws || !this.isSessionAlive) return;

    try {
      const frameBuffer = encodeFrame(type, streamId, flags, payload);
      this.ws.send(frameBuffer);
    } catch {
      this.closeAll('Error sending frame to WebSocket');
    }
  }

  closeAll(reason = 'Session closed') {
    if (!this.isSessionAlive) return;
    this.isSessionAlive = false;

    for (const stream of this.streams.values()) {
      stream.closeStream(0x00);
    }
    this.streams.clear();

    if (this.ws) {
      try {
        this.ws.close(1000, reason);
      } catch {
        // Ignored
      }
      this.ws = null;
    }
  }
}

// session.js
// Cloudflare Durable Object ProxySessionDO for Telegram WEB Proxy
// Transparent MTProto relay to Telegram Data Centers using cloudflare:sockets

import { connect } from 'cloudflare:sockets';
import {
  FRAME_TYPES,
  MAX_DATA_CHUNK,
  encodeFrame,
  decodeFrames,
  verifySessionToken,
  ProtocolError,
} from './protocol.js';

export const TELEGRAM_DC_MAP = Object.freeze({
  1: { ip: '149.154.175.50', port: 443 },
  2: { ip: '149.154.167.51', port: 443 },
  3: { ip: '149.154.175.100', port: 443 },
  4: { ip: '149.154.167.91', port: 443 },
  5: { ip: '91.108.56.165', port: 443 },
});

export const DEFAULT_DC = TELEGRAM_DC_MAP[2];

const MAX_STREAMS_PER_SESSION = 32;
const INITIAL_STREAM_WINDOW = 4 * 1024 * 1024; // 4 MiB
const IDLE_TIMEOUT_MS = 300000; // 5m

class StreamContext {
  constructor(streamId, dcId, abortController) {
    this.streamId = streamId;
    this.dcId = dcId;
    this.abortController = abortController;
    this.inboundWindow = INITIAL_STREAM_WINDOW;
    this.outboundWindow = INITIAL_STREAM_WINDOW;
    this.socket = null;
    this.writer = null;
    this.reader = null;
    this.closed = false;
  }
}

export class ProxySessionDO {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;

    this.ws = null;
    this.rxBuffer = new Uint8Array(0);
    this.streams = new Map(); // streamId -> StreamContext
    this.tombstones = new Set();
  }

  touchIdleTimer() {
    try {
      if (this.ctx?.storage?.setAlarm) {
        this.ctx.storage.setAlarm(Date.now() + IDLE_TIMEOUT_MS);
      }
    } catch {}
  }

  async alarm() {
    this.closeAllStreams(0x00);
    if (this.ws) {
      try {
        this.ws.close(1000, 'Session idle hibernation');
      } catch {}
      this.ws = null;
    }
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const internalAuth = request.headers.get('X-Internal-Auth');
    if (internalAuth !== 'trusted-worker') {
      const token = url.searchParams.get('token');
      if (!token) {
        return new Response('Unauthorized: missing token', { status: 401 });
      }

      const auth = await verifySessionToken(this.env.PROXY_SECRET, token, 3600);
      if (!auth.valid) {
        return new Response('Unauthorized: invalid or expired session token', { status: 403 });
      }
    }

    // @ts-ignore Cloudflare WebSocketPair
    const pair = new WebSocketPair();
    const [clientSocket, serverSocket] = Object.values(pair);

    // @ts-ignore accept server socket
    serverSocket.accept();
    this.ws = serverSocket;
    this.touchIdleTimer();

    this.bindCarrierSocket(serverSocket);

    return new Response(null, {
      status: 101,
      // @ts-ignore webSocket response
      webSocket: clientSocket,
    });
  }

  bindCarrierSocket(ws) {
    ws.addEventListener('message', async (event) => {
      this.touchIdleTimer();
      try {
        let chunk;
        if (typeof event.data === 'string') {
          chunk = new TextEncoder().encode(event.data);
        } else if (event.data instanceof ArrayBuffer) {
          chunk = new Uint8Array(event.data);
        } else {
          chunk = new Uint8Array(await event.data.arrayBuffer());
        }

        const next = new Uint8Array(this.rxBuffer.byteLength + chunk.byteLength);
        next.set(this.rxBuffer, 0);
        next.set(chunk, this.rxBuffer.byteLength);
        this.rxBuffer = next;

        const { frames, remainder } = decodeFrames(this.rxBuffer);
        this.rxBuffer = remainder;

        for (const frame of frames) {
          await this.handleFrame(frame);
        }
      } catch (err) {
        if (err instanceof ProtocolError) {
          this.closeCarrierProtocolViolation(err.message, err.code || 1002);
        } else {
          this.closeCarrierProtocolViolation('Frame decode violation', 1002);
        }
      }
    });

    ws.addEventListener('close', () => {
      this.closeAllStreams(0x00);
      this.ws = null;
    });

    ws.addEventListener('error', () => {
      this.closeAllStreams(0x01);
      this.ws = null;
    });
  }

  async handleFrame(frame) {
    const { type, streamId, flags, payload } = frame;

    switch (type) {
      case FRAME_TYPES.HELLO: {
        // Welcome response: 8-byte payload [4-byte initialWindow BE][4-byte maxStreams BE]
        const welcome = new Uint8Array(8);
        const view = new DataView(welcome.buffer);
        view.setUint32(0, INITIAL_STREAM_WINDOW, false);
        view.setUint32(4, MAX_STREAMS_PER_SESSION, false);
        this.sendFrame(FRAME_TYPES.WELCOME, 0, 0, welcome);
        break;
      }

      case FRAME_TYPES.OPEN: {
        let targetDcId = 2;
        if (payload.byteLength >= 1) {
          targetDcId = payload[0];
        }

        if (this.tombstones.has(streamId) || this.streams.has(streamId)) {
          return;
        }

        if (this.streams.size >= MAX_STREAMS_PER_SESSION) {
          this.sendStreamClose(streamId, 0x03);
          return;
        }

        await this.openDcStream(streamId, targetDcId);
        break;
      }

      case FRAME_TYPES.DATA: {
        const stream = this.streams.get(streamId);
        if (!stream || stream.closed) {
          return;
        }

        await this.forwardDataUpstream(stream, payload);
        break;
      }

      case FRAME_TYPES.WINDOW: {
        const stream = this.streams.get(streamId);
        if (stream && !stream.closed && payload.byteLength >= 4) {
          const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
          const credit = view.getUint32(0, false);
          stream.outboundWindow = Math.min(stream.outboundWindow + credit, INITIAL_STREAM_WINDOW * 2);
        }
        break;
      }

      case FRAME_TYPES.PING: {
        this.sendFrame(FRAME_TYPES.PONG, streamId, flags, payload);
        break;
      }

      case FRAME_TYPES.CLOSE: {
        const code = payload.byteLength >= 1 ? payload[0] : 0x00;
        this.closeStream(streamId, code);
        break;
      }
    }
  }

  async openDcStream(streamId, dcId) {
    const abortController = new AbortController();
    const stream = new StreamContext(streamId, dcId, abortController);
    this.streams.set(streamId, stream);

    const targetDc = TELEGRAM_DC_MAP[dcId] || DEFAULT_DC;

    try {
      const dialTimeout = setTimeout(() => {
        abortController.abort();
      }, 10000);

      // Connect transparently to Telegram DC on port 443
      const socket = connect({
        hostname: targetDc.ip,
        port: targetDc.port,
      });

      clearTimeout(dialTimeout);
      if (stream.closed || abortController.signal.aborted) {
        try { socket.close(); } catch {}
        return;
      }

      stream.socket = socket;
      stream.writer = socket.writable.getWriter();
      stream.reader = socket.readable.getReader();

      this.pumpUpstreamToCarrier(stream);
    } catch (err) {
      this.closeStream(streamId, 0x01);
    }
  }

  async forwardDataUpstream(stream, data) {
    if (stream.closed || !stream.writer || data.byteLength === 0) return;

    try {
      await stream.writer.write(data);

      stream.inboundWindow -= data.byteLength;
      if (stream.inboundWindow <= INITIAL_STREAM_WINDOW / 2) {
        const credit = INITIAL_STREAM_WINDOW - stream.inboundWindow;
        stream.inboundWindow += credit;
        this.sendStreamWindow(stream.streamId, credit);
      }
    } catch {
      this.closeStream(stream.streamId, 0x02);
    }
  }

  async pumpUpstreamToCarrier(stream) {
    try {
      while (!stream.closed && stream.reader) {
        const { value, done } = await stream.reader.read();
        if (done) break;

        if (value && value.byteLength > 0) {
          let offset = 0;
          while (offset < value.byteLength && !stream.closed) {
            const chunkSize = Math.min(MAX_DATA_CHUNK, value.byteLength - offset);
            const chunk = value.subarray(offset, offset + chunkSize);

            this.sendFrame(FRAME_TYPES.DATA, stream.streamId, 0, chunk);
            offset += chunkSize;
            stream.outboundWindow -= chunkSize;

            if (stream.outboundWindow <= 0) {
              await this.waitForStreamCredit(stream);
            }
          }
        }
      }
    } catch {
      // Socket ended
    } finally {
      this.closeStream(stream.streamId, 0x00);
    }
  }

  async waitForStreamCredit(stream) {
    let waited = 0;
    while (stream.outboundWindow <= 0 && !stream.closed && waited < 100) {
      await new Promise((r) => setTimeout(r, 20));
      waited++;
    }
  }

  sendStreamWindow(streamId, credit) {
    const payload = new Uint8Array(4);
    const view = new DataView(payload.buffer);
    view.setUint32(0, credit, false);
    this.sendFrame(FRAME_TYPES.WINDOW, streamId, 0, payload);
  }

  sendStreamClose(streamId, code = 0) {
    const payload = new Uint8Array([code & 0xff]);
    this.sendFrame(FRAME_TYPES.CLOSE, streamId, 0, payload);
  }

  sendFrame(type, streamId = 0, flags = 0, payload = new Uint8Array(0)) {
    if (!this.ws) return;
    try {
      const buffer = encodeFrame(type, streamId, flags, payload);
      this.ws.send(buffer);
    } catch {
      this.closeCarrierProtocolViolation('Carrier write failure', 1002);
    }
  }

  closeStream(streamId, code = 0) {
    const stream = this.streams.get(streamId);
    if (!stream) return;

    stream.closed = true;
    stream.abortController.abort();
    this.streams.delete(streamId);
    this.tombstones.add(streamId);

    try {
      if (stream.writer) stream.writer.close();
      if (stream.reader) stream.reader.cancel();
      if (stream.socket) stream.socket.close();
    } catch {}

    this.sendStreamClose(streamId, code);
  }

  closeAllStreams(code = 0) {
    for (const streamId of Array.from(this.streams.keys())) {
      this.closeStream(streamId, code);
    }
  }

  closeCarrierProtocolViolation(reason, code = 1002) {
    this.closeAllStreams(0x01);
    if (this.ws) {
      try {
        this.ws.close(code, reason);
      } catch {}
      this.ws = null;
    }
  }
}

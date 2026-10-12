// session.js
// Cloudflare SQLite Durable Object ProxySessionDO for Telegram WEB Proxy v1
// Reference: c0nef/telegram-web-cloudflare-workers/app/src/relay.js

import { connect } from 'cloudflare:sockets';
import {
  FRAME_TYPES,
  MAX_DATA_CHUNK,
  encodeFrame,
  decodeFrames,
  verifySessionToken,
  createCtrContext,
  ProtocolError,
} from './protocol.js';

export const TELEGRAM_DC_MAP = Object.freeze({
  1: { ip: '149.154.175.50', port: 443, wsHost: 'pluto.web.telegram.org' },
  2: { ip: '149.154.167.51', port: 443, wsHost: 'venus.web.telegram.org' },
  3: { ip: '149.154.175.100', port: 443, wsHost: 'aurora.web.telegram.org' },
  4: { ip: '149.154.167.91', port: 443, wsHost: 'vesta.web.telegram.org' },
  5: { ip: '91.108.56.165', port: 443, wsHost: 'flora.web.telegram.org' },
});

export const DEFAULT_DC = TELEGRAM_DC_MAP[2];

const MAX_STREAMS_PER_SESSION = 32;
const MAX_DO_PENDING_BYTES = 32 * 1024 * 1024; // 32 MiB DO-wide
const MAX_DO_PENDING_ITEMS = 32768; // 32K items pending
const MAX_DIRECTION_PENDING_BYTES = 4 * 1024 * 1024; // 4 MiB per-direction
const INITIAL_STREAM_WINDOW = 4 * 1024 * 1024; // 4 MiB initial stream window
const MAX_BITMAP_BYTES = 2 * 1024 * 1024; // 2 MiB bounded used-ID bitmap
const MAX_CONCURRENT_DIALS = 4;
const MAX_QUEUED_DIALS = 256;
const IDLE_TIMEOUT_MS = 300000; // 300s (5m) hibernation alarm

class StreamContext {
  constructor(streamId, dcId, abortController) {
    this.streamId = streamId;
    this.dcId = dcId;
    this.abortController = abortController;
    this.inboundWindow = INITIAL_STREAM_WINDOW;
    this.outboundWindow = INITIAL_STREAM_WINDOW;
    this.inboundPendingBytes = 0;
    this.outboundPendingBytes = 0;
    this.socket = null;
    this.writer = null;
    this.reader = null;
    this.closed = false;
    this.ciphers = null; // In-memory CTR contexts, never persisted
  }
}

export class ProxySessionDO {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;

    // Carrier WebSocket state
    this.ws = null;
    this.rxBuffer = new Uint8Array(0);

    // Active streams & per-stream windows
    this.streams = new Map(); // streamId -> StreamContext
    this.tombstones = new Set(); // Closed streamIds

    // Bounded used-ID bitmap (up to 2 MiB = 16,777,216 IDs)
    this.usedIdBitmap = new Uint8Array(Math.min(MAX_BITMAP_BYTES, 65536));

    // Dial queue management
    this.activeDials = 0;
    this.dialQueue = []; // Array<{ streamId, dcId, abortController, resolve, reject }>

    // Aggregate accounting
    this.totalPendingBytes = 0;
    this.totalPendingItems = 0;

    // Ensure session database schema
    this.initSqlite();
  }

  initSqlite() {
    try {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS session_meta (
          key TEXT PRIMARY KEY,
          value TEXT,
          updated_at INTEGER
        );
      `);
    } catch {
      // Non-fatal if in memory-only test mode
    }
  }

  isIdUsed(streamId) {
    if (this.tombstones.has(streamId)) return true;
    const byteIndex = Math.floor(streamId / 8);
    if (byteIndex >= this.usedIdBitmap.length) return false;
    const bitIndex = streamId % 8;
    return (this.usedIdBitmap[byteIndex] & (1 << bitIndex)) !== 0;
  }

  markIdUsed(streamId) {
    let byteIndex = Math.floor(streamId / 8);
    if (byteIndex >= this.usedIdBitmap.length) {
      if (byteIndex >= MAX_BITMAP_BYTES) {
        return; // Bitmap bounded to 2 MiB
      }
      const newSize = Math.min(MAX_BITMAP_BYTES, Math.max(byteIndex + 1, this.usedIdBitmap.length * 2));
      const expanded = new Uint8Array(newSize);
      expanded.set(this.usedIdBitmap, 0);
      this.usedIdBitmap = expanded;
    }
    const bitIndex = streamId % 8;
    this.usedIdBitmap[byteIndex] |= 1 << bitIndex;
  }

  touchIdleTimer() {
    try {
      this.ctx.storage.setAlarm(Date.now() + IDLE_TIMEOUT_MS);
    } catch {
      // Storage alarm non-fatal in runtime mocks
    }
  }

  async alarm() {
    // 300s idle timeout: hibernate and close all active streams
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

      // Lifecycle check: Verify bootstrap validity
      const auth = await verifySessionToken(this.env.PROXY_SECRET, token, 90);
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
    switch (frame.type) {
      case FRAME_TYPES.HELLO: {
        const welcome = new Uint8Array(8);
        const view = new DataView(welcome.buffer);
        view.setUint32(0, INITIAL_STREAM_WINDOW, false);
        view.setUint32(4, MAX_STREAMS_PER_SESSION, false);
        this.sendFrame(FRAME_TYPES.WELCOME, welcome);
        break;
      }

      case FRAME_TYPES.OPEN: {
        if (frame.payload.byteLength < 4) {
          throw new ProtocolError('Malformed OPEN frame: expected stream ID', 1002);
        }
        const view = new DataView(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength);
        const streamId = view.getUint32(0, false);
        const dcId = frame.payload.byteLength >= 5 ? view.getUint8(4) : 2;

        // Duplicate OPEN handling: if in bitmap or tombstones, ignore and don't create new stream
        if (this.isIdUsed(streamId) || this.streams.has(streamId)) {
          return;
        }

        if (this.streams.size >= MAX_STREAMS_PER_SESSION) {
          this.sendStreamClose(streamId, 0x03); // Max streams reached
          return;
        }

        this.markIdUsed(streamId);
        await this.queueDial(streamId, dcId);
        break;
      }

      case FRAME_TYPES.DATA: {
        if (frame.payload.byteLength < 4) {
          throw new ProtocolError('Malformed DATA frame', 1002);
        }
        const view = new DataView(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength);
        const streamId = view.getUint32(0, false);
        const data = frame.payload.subarray(4);

        if (data.byteLength > MAX_DATA_CHUNK) {
          throw new ProtocolError(`DATA chunk ${data.byteLength} exceeds 64KiB`, 1002);
        }

        const stream = this.streams.get(streamId);
        if (!stream || stream.closed) {
          // Closed or tombstoned stream, silently discard data
          return;
        }

        // Check buffer accounting limits
        if (
          this.totalPendingBytes + data.byteLength > MAX_DO_PENDING_BYTES ||
          this.totalPendingItems >= MAX_DO_PENDING_ITEMS ||
          stream.inboundPendingBytes + data.byteLength > MAX_DIRECTION_PENDING_BYTES
        ) {
          throw new ProtocolError('Pending queue byte budget exceeded', 1002);
        }

        await this.forwardDataUpstream(stream, data);
        break;
      }

      case FRAME_TYPES.WINDOW: {
        if (frame.payload.byteLength < 8) {
          throw new ProtocolError('Malformed WINDOW frame', 1002);
        }
        const view = new DataView(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength);
        const streamId = view.getUint32(0, false);
        const credit = view.getUint32(4, false);

        const stream = this.streams.get(streamId);
        if (stream && !stream.closed) {
          stream.outboundWindow = Math.min(stream.outboundWindow + credit, INITIAL_STREAM_WINDOW * 2);
        }
        break;
      }

      case FRAME_TYPES.PING: {
        this.sendFrame(FRAME_TYPES.PONG, frame.payload);
        break;
      }

      case FRAME_TYPES.CLOSE: {
        if (frame.payload.byteLength >= 4) {
          const view = new DataView(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength);
          const streamId = view.getUint32(0, false);
          this.closeStream(streamId, 0x00);
        }
        break;
      }
    }
  }

  async queueDial(streamId, dcId) {
    if (this.dialQueue.length >= MAX_QUEUED_DIALS) {
      this.sendStreamClose(streamId, 0x04); // Dial queue saturated
      return;
    }

    const abortController = new AbortController();
    const stream = new StreamContext(streamId, dcId, abortController);
    this.streams.set(streamId, stream);

    if (this.activeDials < MAX_CONCURRENT_DIALS) {
      this.executeDial(stream);
    } else {
      this.dialQueue.push(stream);
    }
  }

  async executeDial(stream) {
    this.activeDials++;
    const targetDc = TELEGRAM_DC_MAP[stream.dcId] || DEFAULT_DC;

    try {
      const dialTimeout = setTimeout(() => {
        stream.abortController.abort();
      }, 10000); // 10s dial/connect deadline

      // Outbound connect via cloudflare:sockets
      const socket = connect({
        hostname: targetDc.ip,
        port: targetDc.port,
      });

      clearTimeout(dialTimeout);
      if (stream.closed || stream.abortController.signal.aborted) {
        try { socket.close(); } catch {}
        return;
      }

      stream.socket = socket;
      stream.writer = socket.writable.getWriter();
      stream.reader = socket.readable.getReader();

      this.pumpUpstreamToCarrier(stream);
    } catch (err) {
      // Failure isolation: single stream close should not affect others
      this.closeStream(stream.streamId, 0x01);
    } finally {
      this.activeDials--;
      if (this.dialQueue.length > 0) {
        const nextStream = this.dialQueue.shift();
        this.executeDial(nextStream);
      }
    }
  }

  async forwardDataUpstream(stream, data) {
    if (stream.closed || !stream.writer) return;

    try {
      this.totalPendingBytes += data.byteLength;
      this.totalPendingItems++;
      stream.inboundPendingBytes += data.byteLength;

      await stream.writer.write(data);

      stream.inboundWindow -= data.byteLength;
      if (stream.inboundWindow <= INITIAL_STREAM_WINDOW / 2) {
        const credit = INITIAL_STREAM_WINDOW - stream.inboundWindow;
        stream.inboundWindow += credit;
        this.sendStreamWindow(stream.streamId, credit);
      }
    } catch {
      this.closeStream(stream.streamId, 0x02);
    } finally {
      this.totalPendingBytes -= data.byteLength;
      this.totalPendingItems--;
      stream.inboundPendingBytes -= data.byteLength;
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

            // Payload: [4-byte streamId][chunk]
            const payload = new Uint8Array(4 + chunkSize);
            const view = new DataView(payload.buffer);
            view.setUint32(0, stream.streamId, false);
            payload.set(chunk, 4);

            this.sendFrame(FRAME_TYPES.DATA, payload);
            offset += chunkSize;
            stream.outboundWindow -= chunkSize;

            if (stream.outboundWindow <= 0) {
              await this.waitForStreamCredit(stream);
            }
          }
        }
      }
    } catch {
      // Upstream socket finished or closed
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
    const payload = new Uint8Array(8);
    const view = new DataView(payload.buffer);
    view.setUint32(0, streamId, false);
    view.setUint32(4, credit, false);
    this.sendFrame(FRAME_TYPES.WINDOW, payload);
  }

  sendStreamClose(streamId, code = 0) {
    const payload = new Uint8Array(5);
    const view = new DataView(payload.buffer);
    view.setUint32(0, streamId, false);
    view.setUint8(4, code & 0xff);
    this.sendFrame(FRAME_TYPES.CLOSE, payload);
  }

  sendFrame(type, payload = new Uint8Array(0)) {
    if (!this.ws) return;
    try {
      const buffer = encodeFrame(type, payload);
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
    for (const queued of this.dialQueue) {
      queued.abortController.abort();
    }
    this.dialQueue = [];
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

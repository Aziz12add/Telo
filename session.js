// session.js - FIXED VERSION FOR Telo
// Cloudflare SQLite Durable Object ProxySessionDO for Telegram WEB Proxy v1
import { connect } from 'cloudflare:sockets';
import {
  FRAME_TYPES,
  MAX_DATA_CHUNK,
  CARRIER_HARD_MAX,
  encodeFrame,
  decodeFrames,
  createStreamCryptoContexts,
  ProtocolError,
} from './protocol.js';

export const TELEGRAM_DC_MAP = Object.freeze({
  1: { ip: '149.154.175.50', port: 443, wsHost: 'pluto.web.telegram.org' },
  2: { ip: '149.154.167.51', port: 443, wsHost: 'venus.web.telegram.org' },
  3: { ip: '149.154.175.100', port: 443, wsHost: 'aurora.web.telegram.org' },
  4: { ip: '149.154.167.91', port: 443, wsHost: 'vesta.web.telegram.org' },
  5: { ip: '91.108.56.165', port: 443, wsHost: 'flora.web.telegram.org' },
});

const MAX_STREAMS_PER_SESSION = 32;
const MAX_DO_PENDING_BYTES = 32 * 1024 * 1024;
const MAX_DO_PENDING_ITEMS = 32768;
const MAX_DIRECTION_PENDING_BYTES = 4 * 1024 * 1024;
const INITIAL_STREAM_WINDOW = 4 * 1024 * 1024;
const MAX_BITMAP_BYTES = 2 * 1024 * 1024;
const MAX_ID = MAX_BITMAP_BYTES * 8; // 16,777,216
const MAX_CONCURRENT_DIALS = 4;
const MAX_QUEUED_DIALS = 256;
const IDLE_TIMEOUT_MS = 300000;
const MAX_TOMBSTONES = 1024;

class StreamContext {
  constructor(streamId, dcId, abortController) {
    this.streamId = streamId;
    this.dcId = dcId;
    this.abortController = abortController;
    this.inboundWindow = INITIAL_STREAM_WINDOW;
    this.outboundWindow = INITIAL_STREAM_WINDOW;
    this.inboundPendingBytes = 0;
    this.socket = null;
    this.writer = null;
    this.reader = null;
    this.closed = false;
    this.ciphers = null;
    this.creditResolver = null;
  }
}

export class ProxySessionDO {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.ws = null;
    this.rxBuffer = new Uint8Array(0);
    this.streams = new Map();
    this.tombstones = new Set();
    this.usedIdBitmap = new Uint8Array(65536);
    this.activeDials = 0;
    this.dialQueue = [];
    this.totalPendingBytes = 0;
    this.totalPendingItems = 0;
    try {
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS session_meta (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);`);
    } catch {}
  }

  isIdUsed(streamId) {
    if (streamId >= MAX_ID) return true;
    if (this.tombstones.has(streamId)) return true;
    const byteIndex = Math.floor(streamId / 8);
    if (byteIndex >= this.usedIdBitmap.length) return false;
    const bitIndex = streamId % 8;
    return (this.usedIdBitmap[byteIndex] & (1 << bitIndex))!== 0;
  }

  markIdUsed(streamId) {
    if (streamId >= MAX_ID) return;
    let byteIndex = Math.floor(streamId / 8);
    if (byteIndex >= this.usedIdBitmap.length) {
      if (byteIndex >= MAX_BITMAP_BYTES) return;
      const newSize = Math.min(MAX_BITMAP_BYTES, Math.max(byteIndex + 1, this.usedIdBitmap.length * 2));
      const expanded = new Uint8Array(newSize);
      expanded.set(this.usedIdBitmap, 0);
      this.usedIdBitmap = expanded;
    }
    this.usedIdBitmap[byteIndex] |= 1 << (streamId % 8);
  }

  touchIdleTimer() {
    try { this.ctx.storage.setAlarm(Date.now() + IDLE_TIMEOUT_MS); } catch {}
  }

  async alarm() {
    this.closeAllStreams(0x00);
    try { this.ws?.close(1000, 'idle'); } catch {}
    this.ws = null;
  }

  async fetch(request) {
    // FIXED: Check internal auth header from server.ts instead of?token=
    const internalAuth = request.headers.get('X-Internal-Auth');
    if (internalAuth!== 'trusted-worker') {
      return new Response('Unauthorized', { status: 401 });
    }
    if (request.headers.get('Upgrade')!== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.ws = server;
    this.touchIdleTimer();
    this.bindCarrierSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  bindCarrierSocket(ws) {
    ws.addEventListener('message', async (event) => {
      this.touchIdleTimer();
      try {
        let chunk = event.data instanceof ArrayBuffer? new Uint8Array(event.data) : new Uint8Array(await event.data.arrayBuffer());
        // Optimized concat
        if (this.rxBuffer.length === 0) this.rxBuffer = chunk;
        else {
          const next = new Uint8Array(this.rxBuffer.length + chunk.length);
          next.set(this.rxBuffer, 0);
          next.set(chunk, this.rxBuffer.length);
          this.rxBuffer = next;
        }
        if (this.rxBuffer.length > CARRIER_HARD_MAX) throw new ProtocolError('Carrier overflow', 1009);

        const { frames, remainder } = decodeFrames(this.rxBuffer);
        this.rxBuffer = remainder;
        for (const frame of frames) await this.handleFrame(frame);
      } catch (err) {
        this.closeCarrierProtocolViolation(err.message || 'decode error', 1002);
      }
    });
    ws.addEventListener('close', () => { this.closeAllStreams(0x00); this.ws = null; });
    ws.addEventListener('error', () => { this.closeAllStreams(0x01); this.ws = null; });
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
        if (frame.payload.length < 4) throw new ProtocolError('Malformed OPEN', 1002);
        const view = new DataView(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength);
        const streamId = view.getUint32(0, false);
        const dcId = frame.payload.length >= 5? view.getUint8(4) : 2;
        if (this.isIdUsed(streamId) || this.streams.has(streamId)) return;
        if (this.streams.size >= MAX_STREAMS_PER_SESSION) { this.sendStreamClose(streamId, 0x03); return; }
        this.markIdUsed(streamId);
        await this.queueDial(streamId, dcId);
        break;
      }
      case FRAME_TYPES.DATA: {
        if (frame.payload.length < 4) throw new ProtocolError('Malformed DATA', 1002);
        const view = new DataView(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength);
        const streamId = view.getUint32(0, false);
        const data = frame.payload.subarray(4);
        if (data.length > MAX_DATA_CHUNK) throw new ProtocolError('DATA >64KiB', 1002);
        const stream = this.streams.get(streamId);
        if (!stream || stream.closed) return;
        if (this.totalPendingBytes + data.length > MAX_DO_PENDING_BYTES) throw new ProtocolError('DO pending overflow', 1009);
        await this.forwardDataUpstream(stream, data);
        break;
      }
      case FRAME_TYPES.WINDOW: {
        if (frame.payload.length < 8) throw new ProtocolError('Malformed WINDOW', 1002);
        const view = new DataView(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength);
        const streamId = view.getUint32(0, false);
        const credit = view.getUint32(4, false);
        const stream = this.streams.get(streamId);
        if (stream &&!stream.closed) {
          stream.outboundWindow += credit;
          if (stream.creditResolver) { stream.creditResolver(); stream.creditResolver = null; }
        }
        break;
      }
      case FRAME_TYPES.PING: this.sendFrame(FRAME_TYPES.PONG, frame.payload); break;
      case FRAME_TYPES.CLOSE: {
        if (frame.payload.length >= 4) {
          const view = new DataView(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength);
          this.closeStream(view.getUint32(0, false), 0x00);
        }
        break;
      }
    }
  }

  async queueDial(streamId, dcId) {
    if (this.dialQueue.length >= MAX_QUEUED_DIALS) { this.sendStreamClose(streamId, 0x04); return; }
    const ac = new AbortController();
    const stream = new StreamContext(streamId, dcId, ac);
    this.streams.set(streamId, stream);
    if (this.activeDials < MAX_CONCURRENT_DIALS) this.executeDial(stream);
    else this.dialQueue.push(stream);
  }

  async executeDial(stream) {
    this.activeDials++;
    const targetDc = TELEGRAM_DC_MAP[stream.dcId] || TELEGRAM_DC_MAP[2];
    let timeout;
    try {
      timeout = setTimeout(() => stream.abortController.abort(), 10000);
      // FIXED: correct cloudflare:sockets API
      const socket = await connect(`${targetDc.ip}:${targetDc.port}`);
      clearTimeout(timeout);
      if (stream.closed || stream.abortController.signal.aborted) { try { socket.close(); } catch {} return; }

      // FIXED: Create CTR contexts - memory only, never persisted
      // In real MTProxy, keys derived from outer handshake. For v1 we use dummy zero keys for relay mode
      // because Telegram DC does its own MTProto encryption inside.
      const dummyKey = new Uint8Array(32); const dummyIv = new Uint8Array(16);
      // For production, replace with keys derived from MTProxy outer layer
      stream.ciphers = createStreamCryptoContexts({
        clientDecryptKey: dummyKey, clientDecryptIv: dummyIv,
        upstreamEncryptKey: dummyKey, upstreamEncryptIv: dummyIv,
        upstreamDecryptKey: dummyKey, upstreamDecryptIv: dummyIv,
        clientEncryptKey: dummyKey, clientEncryptIv: dummyIv,
      });

      stream.socket = socket;
      stream.writer = socket.writable.getWriter();
      stream.reader = socket.readable.getReader();
      this.pumpUpstreamToCarrier(stream);
    } catch {
      clearTimeout(timeout);
      this.closeStream(stream.streamId, 0x01);
    } finally {
      this.activeDials--;
      if (this.dialQueue.length > 0) this.executeDial(this.dialQueue.shift());
    }
  }

  async forwardDataUpstream(stream, data) {
    if (stream.closed ||!stream.writer) return;
    try {
      this.totalPendingBytes += data.length;
      this.totalPendingItems++;
      stream.inboundPendingBytes += data.length;
      // FIXED: If ciphers exist, decrypt outer then encrypt inner (for full MTProxy mode)
      let out = data;
      if (stream.ciphers) {
        const dec = await stream.ciphers.outerClientDecrypt.decrypt(data);
        out = await stream.ciphers.innerClientEncrypt.encrypt(dec);
      }
      await stream.writer.write(out);
      stream.inboundWindow -= data.length;
      if (stream.inboundWindow <= INITIAL_STREAM_WINDOW / 2) {
        const credit = INITIAL_STREAM_WINDOW - stream.inboundWindow;
        stream.inboundWindow += credit;
        this.sendStreamWindow(stream.streamId, credit);
      }
    } catch { this.closeStream(stream.streamId, 0x02); }
    finally {
      this.totalPendingBytes -= data.length;
      this.totalPendingItems--;
      stream.inboundPendingBytes -= data.length;
    }
  }

  async pumpUpstreamToCarrier(stream) {
    try {
      while (!stream.closed && stream.reader) {
        const { value, done } = await stream.reader.read();
        if (done) break;
        if (!value?.length) continue;
        let offset = 0;
        while (offset < value.length &&!stream.closed) {
          const chunkSize = Math.min(MAX_DATA_CHUNK, value.length - offset);
          let chunk = value.subarray(offset, offset + chunkSize);
          if (stream.ciphers) {
            const dec = await stream.ciphers.innerServerDecrypt.decrypt(chunk);
            chunk = await stream.ciphers.outerServerEncrypt.encrypt(dec);
          }
          const payload = new Uint8Array(4 + chunk.length);
          new DataView(payload.buffer).setUint32(0, stream.streamId, false);
          payload.set(chunk, 4);
          this.sendFrame(FRAME_TYPES.DATA, payload);
          offset += chunkSize;
          stream.outboundWindow -= chunkSize;
          if (stream.outboundWindow <= 0) await this.waitForStreamCredit(stream);
        }
      }
    } catch {} finally { this.closeStream(stream.streamId, 0x00); }
  }

  waitForStreamCredit(stream) {
    if (stream.outboundWindow > 0) return Promise.resolve();
    return new Promise((resolve) => {
      stream.creditResolver = resolve;
      setTimeout(() => { if (stream.creditResolver) { stream.creditResolver(); stream.creditResolver = null; } }, 5000);
    });
  }

  sendStreamWindow(streamId, credit) {
    const p = new Uint8Array(8); const v = new DataView(p.buffer);
    v.setUint32(0, streamId, false); v.setUint32(4, credit, false);
    this.sendFrame(FRAME_TYPES.WINDOW, p);
  }
  sendStreamClose(streamId, code = 0) {
    const p = new Uint8Array(5); const v = new DataView(p.buffer);
    v.setUint32(0, streamId, false); v.setUint8(4, code);
    this.sendFrame(FRAME_TYPES.CLOSE, p);
  }
  sendFrame(type, payload = new Uint8Array(0)) {
    if (!this.ws) return;
    try { this.ws.send(encodeFrame(type, payload)); }
    catch { this.closeCarrierProtocolViolation('write fail', 1002); }
  }
  closeStream(streamId, code = 0) {
    const stream = this.streams.get(streamId);
    if (!stream) return;
    stream.closed = true;
    try { stream.abortController.abort(); } catch {}
    this.streams.delete(streamId);
    this.tombstones.add(streamId);
    if (this.tombstones.size > MAX_TOMBSTONES) {
      const first = this.tombstones.values().next().value;
      this.tombstones.delete(first);
    }
    if (stream.creditResolver) { stream.creditResolver(); stream.creditResolver = null; }
    try { stream.writer?.close(); stream.reader?.cancel(); stream.socket?.close(); } catch {}
    this.sendStreamClose(streamId, code);
  }
  closeAllStreams(code = 0) {
    for (const id of [...this.streams.keys()]) this.closeStream(id, code);
    for (const q of this.dialQueue) try { q.abortController.abort(); } catch {}
    this.dialQueue = [];
  }
  closeCarrierProtocolViolation(reason, code = 1002) {
    this.closeAllStreams(0x01);
    try { this.ws?.close(code, reason); } catch {}
    this.ws = null;
  }
}

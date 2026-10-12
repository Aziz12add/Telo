// session.js — ProxySessionDO (TCP relay to Telegram DCs)
import { connect } from 'cloudflare:sockets';
import {
  FRAME_TYPES,
  MAX_DATA_CHUNK,
  CARRIER_HARD_MAX,
  encodeFrame,
  decodeFrames,
  verifySessionToken,
  ProtocolError,
} from './protocol.js';

export const TELEGRAM_DCS = Object.freeze({
  1: { ip: '149.154.175.50', port: 443 },
  2: { ip: '149.154.167.51', port: 443 },
  3: { ip: '149.154.175.100', port: 443 },
  4: { ip: '149.154.167.91', port: 443 },
  5: { ip: '91.108.56.165', port: 443 },
});

const WINDOW_INITIAL = 4 * 1024 * 1024;
const MAX_STREAMS = 32;

class StreamSession {
  constructor(streamId, ip, port, parent) {
    this.streamId = streamId;
    this.ip = ip;
    this.port = port;
    this.parent = parent;
    this.socket = null;
    this.writer = null;
    this.reader = null;
    this.closed = false;
    this.egressWindow = WINDOW_INITIAL;
  }

  async start() {
    try {
      this.socket = connect({ hostname: this.ip, port: this.port });
      await this.socket.opened;
      this.writer = this.socket.writable.getWriter();
      this.reader = this.socket.readable.getReader();
      this.pumpDcToClient();
    } catch {
      this.close(0x01);
    }
  }

  async writeUpstream(payload) {
    if (this.closed || !this.writer) return;
    try {
      await this.writer.write(payload);
    } catch {
      this.close(0x02);
    }
  }

  async pumpDcToClient() {
    try {
      while (!this.closed && this.reader) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (!value?.byteLength) continue;
        let offset = 0;
        while (offset < value.byteLength && !this.closed) {
          const n = Math.min(MAX_DATA_CHUNK, value.byteLength - offset, Math.max(1, this.egressWindow));
          const chunk = value.subarray(offset, offset + n);
          this.parent.sendData(this.streamId, chunk);
          this.egressWindow -= n;
          offset += n;
          if (this.egressWindow <= 0) {
            await new Promise((r) => setTimeout(r, 20));
          }
        }
      }
    } catch {
      /* ignore */
    } finally {
      this.close(0x00);
    }
  }

  addCredit(n) {
    this.egressWindow = Math.min(WINDOW_INITIAL * 2, this.egressWindow + n);
  }

  close(code = 0) {
    if (this.closed) return;
    this.closed = true;
    try {
      this.writer?.close();
      this.reader?.cancel();
      this.socket?.close();
    } catch {
      /* ignore */
    }
    this.parent.notifyClosed(this.streamId, code);
  }
}

export class ProxySessionDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.ws = null;
    this.streams = new Map();
    this.rxBuffer = new Uint8Array(0);
    this.alive = false;
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }
    const url = new URL(request.url);
    const token = url.searchParams.get('token');
    if (!token || !this.env.PROXY_SECRET) {
      return new Response('Unauthorized', { status: 401 });
    }
    const auth = await verifySessionToken(this.env.PROXY_SECRET, token);
    if (!auth.valid) return new Response('Forbidden', { status: 403 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.ws = server;
    this.alive = true;
    this.bind(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  bind(ws) {
    ws.addEventListener('message', async (event) => {
      try {
        let chunk;
        if (event.data instanceof ArrayBuffer) chunk = new Uint8Array(event.data);
        else if (typeof event.data === 'string') chunk = new TextEncoder().encode(event.data);
        else chunk = new Uint8Array(await event.data.arrayBuffer());

        const next = new Uint8Array(this.rxBuffer.length + chunk.length);
        next.set(this.rxBuffer);
        next.set(chunk, this.rxBuffer.length);
        this.rxBuffer = next;
        if (this.rxBuffer.length > CARRIER_HARD_MAX) throw new ProtocolError('overflow', 1009);

        const { frames, remainder } = decodeFrames(this.rxBuffer);
        this.rxBuffer = remainder;
        for (const f of frames) await this.onFrame(f);
      } catch {
        this.shutdown();
      }
    });
    ws.addEventListener('close', () => this.shutdown());
    ws.addEventListener('error', () => this.shutdown());
  }

  async onFrame(frame) {
    switch (frame.type) {
      case FRAME_TYPES.HELLO: {
        const payload = new Uint8Array(8);
        const v = new DataView(payload.buffer);
        v.setUint32(0, WINDOW_INITIAL, false);
        v.setUint32(4, MAX_STREAMS, false);
        this.send(FRAME_TYPES.WELCOME, 0, payload);
        break;
      }
      case FRAME_TYPES.OPEN: {
        const streamId = frame.streamId || 1;
        if (this.streams.has(streamId) || this.streams.size >= MAX_STREAMS) {
          this.notifyClosed(streamId, 0x03);
          return;
        }
        let dcId = 2;
        if (frame.payload?.byteLength >= 1) dcId = frame.payload[0] || 2;
        const dc = TELEGRAM_DCS[dcId] || TELEGRAM_DCS[2];
        const s = new StreamSession(streamId, dc.ip, dc.port, this);
        this.streams.set(streamId, s);
        await s.start();
        break;
      }
      case FRAME_TYPES.DATA: {
        const s = this.streams.get(frame.streamId);
        if (s && frame.payload?.byteLength) await s.writeUpstream(frame.payload);
        break;
      }
      case FRAME_TYPES.WINDOW: {
        const s = this.streams.get(frame.streamId);
        if (s && frame.payload?.byteLength >= 4) {
          const credit = new DataView(
            frame.payload.buffer,
            frame.payload.byteOffset,
            4
          ).getUint32(0, false);
          s.addCredit(credit);
        }
        break;
      }
      case FRAME_TYPES.PING:
        this.send(FRAME_TYPES.PONG, frame.streamId, frame.payload);
        break;
      case FRAME_TYPES.CLOSE: {
        const s = this.streams.get(frame.streamId);
        if (s) {
          this.streams.delete(frame.streamId);
          s.close(0);
        }
        break;
      }
    }
  }

  sendData(streamId, payload) {
    this.send(FRAME_TYPES.DATA, streamId, payload);
  }

  notifyClosed(streamId, code = 0) {
    this.streams.delete(streamId);
    const p = new Uint8Array(1);
    p[0] = code & 0xff;
    this.send(FRAME_TYPES.CLOSE, streamId, p);
  }

  send(type, streamId, payload = new Uint8Array(0)) {
    if (!this.ws || !this.alive) return;
    try {
      this.ws.send(encodeFrame(type, streamId, 0, payload));
    } catch {
      this.shutdown();
    }
  }

  shutdown() {
    if (!this.alive) return;
    this.alive = false;
    for (const s of this.streams.values()) s.close(0);
    this.streams.clear();
    try {
      this.ws?.close(1000);
    } catch {
      /* ignore */
    }
    this.ws = null;
  }
}

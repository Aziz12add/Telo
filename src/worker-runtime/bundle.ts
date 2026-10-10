/**
 * Bundle generator that prepares multi-file ES module Worker scripts
 * and the exact Cloudflare v4 metadata JSON payload for multipart upload.
 */

export interface WorkerBundleConfig {
  workerName: string;
  proxySecret: string;
  customHostname?: string;
}

export interface WorkerBundle {
  metadata: any;
  files: Record<string, string>;
}

export function generateWorkerBundle(config: WorkerBundleConfig): WorkerBundle {
  const { workerName, proxySecret, customHostname } = config;

  // Metadata according to Cloudflare Workers v4 multipart upload specifications
  const metadata = {
    main_module: 'index.js',
    compatibility_date: '2024-11-11',
    compatibility_flags: ['nodejs_compat'],
    bindings: [
      {
        type: 'secret_text',
        name: 'PROXY_SECRET',
        text: proxySecret
      },
      {
        type: 'durable_object_namespace',
        name: 'SESSIONS',
        class_name: 'ProxySessionDO'
      },
      {
        type: 'plain_text',
        name: 'PUBLIC_HOSTNAME',
        text: customHostname || ''
      },
      {
        type: 'plain_text',
        name: 'MAX_STREAMS',
        text: '32'
      },
      {
        type: 'plain_text',
        name: 'SESSION_TTL_SECONDS',
        text: '3600'
      }
    ],
    migrations: {
      new_sqlite_classes: ['ProxySessionDO']
    }
  };

  // 1. mtproxy.js
  const mtproxyCode = `// Telegram MTProto & Crypto Engine
export const TELEGRAM_DCS = {
  1: { id: 1, ip: '149.154.175.50', port: 443, name: 'DC1 (Miami)' },
  2: { id: 2, ip: '149.154.167.51', port: 443, name: 'DC2 (Amsterdam)' },
  3: { id: 3, ip: '149.154.175.100', port: 443, name: 'DC3 (Miami)' },
  4: { id: 4, ip: '149.154.167.91', port: 443, name: 'DC4 (Amsterdam)' },
  5: { id: 5, ip: '91.108.56.165', port: 443, name: 'DC5 (Singapore)' }
};
export const DEFAULT_DC = TELEGRAM_DCS[2];

export class Aes256Ctr {
  constructor(key, iv) {
    this.key = new Uint8Array(key);
    this.counter = new Uint8Array(iv);
    this.keystreamBuffer = new Uint8Array(0);
    this.keystreamOffset = 0;
  }

  async process(data) {
    const result = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) {
      if (this.keystreamOffset >= this.keystreamBuffer.length) {
        await this.generateKeystream(64);
      }
      result[i] = data[i] ^ this.keystreamBuffer[this.keystreamOffset++];
    }
    return result;
  }

  async generateKeystream(blocks) {
    const pt = new Uint8Array(blocks * 16);
    for (let b = 0; b < blocks; b++) {
      pt.set(this.counter, b * 16);
      this.increment();
    }
    try {
      const ctrKey = await crypto.subtle.importKey('raw', this.key, { name: 'AES-CTR', length: 256 }, false, ['encrypt']);
      const stream = await crypto.subtle.encrypt({ name: 'AES-CTR', counter: pt.slice(0, 16), length: 64 }, ctrKey, new Uint8Array(blocks * 16));
      this.keystreamBuffer = new Uint8Array(stream);
      this.keystreamOffset = 0;
    } catch {
      this.keystreamBuffer = new Uint8Array(blocks * 16);
      this.keystreamOffset = 0;
    }
  }

  increment() {
    for (let i = 15; i >= 0; i--) {
      this.counter[i]++;
      if (this.counter[i] !== 0) break;
    }
  }
}

export async function parseMTProxyHandshake(client64Bytes, secretBytes) {
  if (client64Bytes.length < 64) return null;
  const b0 = client64Bytes[0];
  if (b0 === 0xef) return null;

  const keySlice = client64Bytes.slice(8, 40);
  const ivSlice = client64Bytes.slice(40, 56);

  const decKeyMat = new Uint8Array(keySlice.length + secretBytes.length);
  decKeyMat.set(keySlice, 0);
  decKeyMat.set(secretBytes, keySlice.length);
  const decKeyHash = new Uint8Array(await crypto.subtle.digest('SHA-256', decKeyMat));

  const revKeySlice = new Uint8Array(keySlice).reverse();
  const revIvSlice = new Uint8Array(ivSlice).reverse();

  const encKeyMat = new Uint8Array(revKeySlice.length + secretBytes.length);
  encKeyMat.set(revKeySlice, 0);
  encKeyMat.set(secretBytes, revKeySlice.length);
  const encKeyHash = new Uint8Array(await crypto.subtle.digest('SHA-256', encKeyMat));

  const clientDecryptCipher = new Aes256Ctr(decKeyHash, ivSlice);
  const clientEncryptCipher = new Aes256Ctr(encKeyHash, revIvSlice);

  const decrypted64 = await clientDecryptCipher.process(client64Bytes.slice(0, 64));

  let dcId = decrypted64[60] | (decrypted64[61] << 8);
  if (dcId > 32767) dcId = dcId - 65536;
  dcId = Math.abs(dcId);

  const upstreamDc = TELEGRAM_DCS[dcId] || DEFAULT_DC;

  return {
    valid: true,
    dcId: dcId || 2,
    clientDecryptCipher,
    clientEncryptCipher,
    upstreamDc,
    upstreamHandshakePacket: decrypted64
  };
}

export function parseSecretHex(secretHex) {
  let clean = (secretHex || '').trim().toLowerCase();
  if (clean.startsWith('dd') && clean.length === 34) clean = clean.slice(2);
  if (clean.startsWith('ee')) clean = clean.slice(2, 34);
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(clean.substring(i * 2, i * 2 + 2) || '00', 16);
  }
  return bytes;
}
`;

  // 2. protocol.js
  const protocolCode = `// Binary Protocol Framing & Tokens
export const FRAME_TYPES = {
  HELLO: 0x01,
  WELCOME: 0x02,
  DATA: 0x03,
  WINDOW_UPDATE: 0x04,
  PING: 0x05,
  PONG: 0x06,
  CLOSE: 0x0f
};

export function encodeFrame(type, streamId, flags, payload) {
  const len = payload.byteLength;
  const buffer = new Uint8Array(8 + len);
  const view = new DataView(buffer.buffer);
  view.setUint8(0, type);
  view.setUint16(1, streamId, false);
  view.setUint8(3, flags);
  view.setUint32(4, len, false);
  buffer.set(payload, 8);
  return buffer;
}

export function decodeFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset + 8 <= buffer.byteLength) {
    const view = new DataView(buffer.buffer, buffer.byteOffset + offset, 8);
    const type = view.getUint8(0);
    const streamId = view.getUint16(1, false);
    const flags = view.getUint8(3);
    const payloadLen = view.getUint32(4, false);
    if (offset + 8 + payloadLen > buffer.byteLength) break;
    const payload = buffer.slice(offset + 8, offset + 8 + payloadLen);
    frames.push({ type, streamId, flags, payload });
    offset += 8 + payloadLen;
  }
  return { frames, remainder: buffer.slice(offset) };
}

export async function signSessionToken(secret, sessionId, timestamp) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const data = enc.encode('telo:v2:' + sessionId + ':' + timestamp);
  const sig = await crypto.subtle.sign('HMAC', key, data);
  const hex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  return sessionId + '.' + timestamp + '.' + hex;
}

export async function verifySessionToken(secret, token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const [sessionId, tsStr, signature] = parts;
    const ts = parseInt(tsStr, 10);
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - ts) > 3600) return false;
    const expected = await signSessionToken(secret, sessionId, ts);
    const expectedSig = expected.split('.')[2];
    if (signature.length !== expectedSig.length) return false;
    let diff = 0;
    for (let i = 0; i < signature.length; i++) diff |= signature.charCodeAt(i) ^ expectedSig.charCodeAt(i);
    return diff === 0;
  } catch {
    return false;
  }
}
`;

  // 3. session.js
  const sessionCode = `// Durable Object Session Manager
import { connect } from 'cloudflare:sockets';
import { TELEGRAM_DCS, DEFAULT_DC, parseMTProxyHandshake, parseSecretHex } from './mtproxy.js';
import { FRAME_TYPES, encodeFrame, decodeFrames, verifySessionToken } from './protocol.js';

export class ProxySessionDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.ws = null;
    this.upstreamSocket = null;
    this.upstreamWriter = null;
    this.upstreamReader = null;
    this.targetDc = DEFAULT_DC;
    this.clientIncomingBuffer = new Uint8Array(0);
    this.clientDecryptCipher = null;
    this.clientEncryptCipher = null;
    this.isHandshakeComplete = false;
    this.sessionWindow = 65536;
    this.closed = false;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/ws') {
      const upgradeHeader = request.headers.get('Upgrade');
      if (upgradeHeader !== 'websocket') return new Response('Expected WebSocket upgrade', { status: 426 });

      const token = url.searchParams.get('token');
      const dcParam = parseInt(url.searchParams.get('dc') || '2', 10);
      this.targetDc = TELEGRAM_DCS[dcParam] || DEFAULT_DC;

      if (!token || !(await verifySessionToken(this.env.PROXY_SECRET, token))) {
        return new Response('Unauthorized session token', { status: 401 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      this.ws = server;
      this.setupWebSocket(server);

      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === '/stats') {
      return new Response(JSON.stringify({
        targetDc: this.targetDc.name,
        isHandshakeComplete: this.isHandshakeComplete,
        window: this.sessionWindow
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response('Not found', { status: 404 });
  }

  setupWebSocket(ws) {
    ws.addEventListener('message', async (event) => {
      try {
        let chunk;
        if (typeof event.data === 'string') chunk = new TextEncoder().encode(event.data);
        else if (event.data instanceof ArrayBuffer) chunk = new Uint8Array(event.data);
        else chunk = new Uint8Array(await event.data.arrayBuffer());
        await this.handleIncomingClientBytes(chunk);
      } catch (err) {
        this.closeSession('Error handling client message');
      }
    });

    ws.addEventListener('close', () => this.closeSession('Client WebSocket closed'));
    ws.addEventListener('error', () => this.closeSession('WebSocket error'));
  }

  async handleIncomingClientBytes(chunk) {
    const next = new Uint8Array(this.clientIncomingBuffer.byteLength + chunk.byteLength);
    next.set(this.clientIncomingBuffer, 0);
    next.set(chunk, this.clientIncomingBuffer.byteLength);
    this.clientIncomingBuffer = next;

    if (this.clientIncomingBuffer.length >= 8 && this.clientIncomingBuffer[0] <= 0x0f) {
      const { frames, remainder } = decodeFrames(this.clientIncomingBuffer);
      this.clientIncomingBuffer = remainder;
      for (const frame of frames) await this.handleBridgeFrame(frame);
      return;
    }

    if (!this.isHandshakeComplete) {
      if (this.clientIncomingBuffer.length < 64) return;

      const raw64 = this.clientIncomingBuffer.slice(0, 64);
      const secretBytes = parseSecretHex(this.env.PROXY_SECRET);
      const handshake = await parseMTProxyHandshake(raw64, secretBytes);

      if (!handshake || !handshake.valid) {
        this.closeSession('Invalid MTProxy handshake');
        return;
      }

      this.clientDecryptCipher = handshake.clientDecryptCipher;
      this.clientEncryptCipher = handshake.clientEncryptCipher;
      this.targetDc = handshake.upstreamDc;
      this.isHandshakeComplete = true;

      await this.connectUpstream();
      if (this.upstreamWriter) await this.upstreamWriter.write(handshake.upstreamHandshakePacket);

      const leftover = this.clientIncomingBuffer.slice(64);
      this.clientIncomingBuffer = new Uint8Array(0);
      if (leftover.length > 0 && this.clientDecryptCipher && this.upstreamWriter) {
        const dec = await this.clientDecryptCipher.process(leftover);
        await this.upstreamWriter.write(dec);
      }
    } else {
      const data = this.clientIncomingBuffer;
      this.clientIncomingBuffer = new Uint8Array(0);
      if (this.clientDecryptCipher && this.upstreamWriter) {
        const dec = await this.clientDecryptCipher.process(data);
        await this.upstreamWriter.write(dec);
      }
    }
  }

  async handleBridgeFrame(frame) {
    switch (frame.type) {
      case FRAME_TYPES.HELLO: {
        const welcome = new Uint8Array(8);
        const view = new DataView(welcome.buffer);
        view.setUint32(0, this.sessionWindow, false);
        view.setUint32(4, 32, false);
        this.sendFrame(FRAME_TYPES.WELCOME, 0, 0, welcome);
        await this.connectUpstream();
        break;
      }
      case FRAME_TYPES.DATA: {
        if (!this.upstreamWriter) await this.connectUpstream();
        if (this.upstreamWriter && frame.payload.byteLength > 0) {
          await this.upstreamWriter.write(frame.payload);
        }
        break;
      }
      case FRAME_TYPES.WINDOW_UPDATE: {
        const view = new DataView(frame.payload.buffer, frame.payload.byteOffset, 4);
        const credit = view.getUint32(0, false);
        this.sessionWindow = Math.min(this.sessionWindow + credit, 1048576);
        break;
      }
      case FRAME_TYPES.PING: {
        this.sendFrame(FRAME_TYPES.PONG, frame.streamId, 0, frame.payload);
        break;
      }
    }
  }

  sendFrame(type, streamId, flags, payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const encoded = encodeFrame(type, streamId, flags, payload);
      this.ws.send(encoded);
    }
  }

  async connectUpstream() {
    if (this.upstreamSocket) return;
    try {
      this.upstreamSocket = connect({
        hostname: this.targetDc.ip,
        port: this.targetDc.port
      });
      this.upstreamWriter = this.upstreamSocket.writable.getWriter();
      this.upstreamReader = this.upstreamSocket.readable.getReader();
      this.pumpUpstream();
    } catch (err) {
      this.closeSession('Failed to connect to Telegram DC');
    }
  }

  async pumpUpstream() {
    try {
      while (!this.closed && this.upstreamReader) {
        const { value, done } = await this.upstreamReader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          if (this.clientEncryptCipher) {
            const enc = await this.clientEncryptCipher.process(value);
            if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(enc);
          } else {
            this.sendFrame(FRAME_TYPES.DATA, 1, 0, value);
          }
        }
      }
    } catch {
    } finally {
      this.closeSession('Upstream finished');
    }
  }

  closeSession(reason) {
    if (this.closed) return;
    this.closed = true;
    try { if (this.upstreamWriter) this.upstreamWriter.close(); } catch {}
    try { if (this.upstreamReader) this.upstreamReader.cancel(); } catch {}
    try { if (this.upstreamSocket) this.upstreamSocket.close(); } catch {}
    try { if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close(1000, reason); } catch {}
  }
}
`;

  // 4. index.js
  const indexCode = `// Telo Main Worker Entry Point
import { ProxySessionDO } from './session.js';
import { signSessionToken } from './protocol.js';

export { ProxySessionDO };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const host = env.PUBLIC_HOSTNAME || request.headers.get('host') || url.host;

    const securityHeaders = {
      'Content-Security-Policy': "default-src 'self' 'unsafe-inline' https: data:; connect-src 'self' wss: https:;",
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY'
    };

    if (url.pathname === '/healthz') {
      return new Response(JSON.stringify({
        ok: true,
        service: 'telo-telegram-proxy',
        host,
        timestamp: Math.floor(Date.now() / 1000)
      }), {
        headers: { 'Content-Type': 'application/json', ...securityHeaders }
      });
    }

    if (url.pathname === '/api/session') {
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      const sessionId = crypto.randomUUID();
      const ts = Math.floor(Date.now() / 1000);
      const token = await signSessionToken(env.PROXY_SECRET, sessionId, ts);
      return new Response(JSON.stringify({
        ok: true,
        sessionId,
        token,
        wsUrl: 'wss://' + host + '/ws?token=' + encodeURIComponent(token) + '&dc=2',
        host,
        port: 443
      }), {
        headers: { 'Content-Type': 'application/json', ...securityHeaders }
      });
    }

    if (url.pathname === '/ws') {
      const token = url.searchParams.get('token');
      if (!token) return new Response('Missing session token', { status: 401 });
      const sessionId = token.split('.')[0] || 'default';
      const id = env.SESSIONS.idFromName(sessionId);
      const obj = env.SESSIONS.get(id);
      return obj.fetch(request);
    }

    if (url.pathname === '/') {
      const secret = env.PROXY_SECRET;
      const cleanSecret = secret.startsWith('dd') ? secret : 'dd' + secret;
      const tgDeepLink = 'tg://proxy?server=' + host + '&port=443&secret=' + cleanSecret;
      const tgWebLink = 'https://t.me/proxy?server=' + host + '&port=443&secret=' + cleanSecret;

      const html = '<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Telo Telegram Proxy</title><style>body{font-family:system-ui,-apple-system,sans-serif;background:#090d16;color:#f1f5f9;display:flex;justify-content:center;align-items:center;min-height:100vh;padding:16px;margin:0;}.card{background:#111827;border:1px solid #1f2937;border-radius:16px;max-width:540px;width:100%;padding:28px;box-shadow:0 20px 25px -5px rgba(0,0,0,0.5);}.badge{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:9999px;font-size:12px;background:#064e3b;color:#34d399;border:1px solid #059669;margin-bottom:14px;}.pulse{width:8px;height:8px;border-radius:50%;background:#10b981;animation:pulse 2s infinite;}@keyframes pulse{0%{opacity:1;}50%{opacity:0.3;}100%{opacity:1;}}h1{font-size:20px;color:#38bdf8;margin-bottom:8px;}p{font-size:13px;color:#94a3b8;line-height:1.6;margin-bottom:20px;}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px;}.box{background:#0b0f19;border:1px solid #1e293b;border-radius:10px;padding:12px;}.box-title{font-size:11px;color:#64748b;margin-bottom:4px;}.box-val{font-family:monospace;font-size:12px;color:#e2e8f0;direction:ltr;text-align:left;word-break:break-all;}.btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;padding:12px;border-radius:10px;font-size:14px;font-weight:600;text-decoration:none;cursor:pointer;border:none;margin-bottom:10px;}.btn-primary{background:#0284c7;color:white;}.btn-secondary{background:#1e293b;color:#cbd5e1;border:1px solid #334155;}</style></head><body><div class="card"><span class="badge"><span class="pulse"></span> ورکر متصل به دیتاسنتر ۲ تلگرام (آمستردام)</span><h1>پروکسی فعال تلگرام Telo</h1><p>اجرا شده بر روی بسترهای ابری کلودفلر با اتصال مستقیم TCP به دیتاسنتر اصلی تلگرام اروپا/ایران.</p><div class="grid"><div class="box"><div class="box-title">هاست سرور (Host)</div><div class="box-val">' + host + '</div></div><div class="box"><div class="box-title">پورت اتصال (Port)</div><div class="box-val">443</div></div><div class="box" style="grid-column: span 2;"><div class="box-title">سکرت (Secret)</div><div class="box-val">' + secret + '</div></div></div><a href="' + tgDeepLink + '" class="btn btn-primary">اتصال مستقیم به تلگرام (Open in Telegram)</a><a href="' + tgWebLink + '" target="_blank" class="btn btn-secondary">باز کردن لینک وب (t.me/proxy)</a></div></body></html>';

      return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...securityHeaders }
      });
    }

    return new Response('404 Not Found', { status: 404, headers: securityHeaders });
  }
};
`;

  return {
    metadata,
    files: {
      'index.js': indexCode,
      'session.js': sessionCode,
      'protocol.js': protocolCode,
      'mtproxy.js': mtproxyCode
    }
  };
}

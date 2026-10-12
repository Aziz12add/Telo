// protocol.js — WEB Proxy v1 frames + bridge HMAC

export const FRAME_TYPES = Object.freeze({
  HELLO: 0x01,
  WELCOME: 0x02,
  OPEN: 0x03,
  DATA: 0x04,
  CLOSE: 0x05,
  WINDOW: 0x06,
  PING: 0x07,
  PONG: 0x08,
});

export const HEADER_SIZE = 8;
export const MAX_FRAME_PAYLOAD_SIZE = 1024 * 1024;
export const MAX_DATA_CHUNK = 64 * 1024;
export const CARRIER_HARD_MAX = 2 * 1024 * 1024;

export class ProtocolError extends Error {
  constructor(message, closeCode = 1002) {
    super(message);
    this.name = 'ProtocolError';
    this.closeCode = closeCode;
  }
}

export function parseSecret(secretHex) {
  if (typeof secretHex !== 'string') throw new TypeError('Secret must be a hex string');
  let s = secretHex.trim().toLowerCase();
  if (s.startsWith('dd')) s = s.slice(2);
  if (s.length !== 32 || !/^[0-9a-f]{32}$/.test(s)) {
    throw new Error('Secret must be 32 hex chars (or dd + 32 hex chars)');
  }
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

export function toBase64UrlNoPad(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function constantTimeCompare(a, b) {
  if (typeof a === 'string' && typeof b === 'string') {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }
  const ua = a instanceof Uint8Array ? a : new TextEncoder().encode(String(a));
  const ub = b instanceof Uint8Array ? b : new TextEncoder().encode(String(b));
  if (ua.length !== ub.length) return false;
  let diff = 0;
  for (let i = 0; i < ua.length; i++) diff |= ua[i] ^ ub[i];
  return diff === 0;
}

export async function computeBridgeCapability(secret, hostname) {
  const secretBytes = typeof secret === 'string' ? parseSecret(secret) : secret;
  const host = String(hostname || '').trim().toLowerCase().split(':')[0];
  const context = new TextEncoder().encode(`tdesktop-web-proxy-bridge-v1\n${host}`);
  const key = await crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toBase64UrlNoPad(await crypto.subtle.sign('HMAC', key, context));
}

export async function verifyBridgeCapability(providedBridge, secret, hostname) {
  const expected = await computeBridgeCapability(secret, hostname);
  return constantTimeCompare(String(providedBridge || ''), expected);
}

export async function signSessionToken(secret, sessionId, timestamp) {
  const secretBytes = typeof secret === 'string' ? parseSecret(secret) : secret;
  const data = new TextEncoder().encode(`session-v1\n\( {sessionId}\n \){timestamp}`);
  const key = await crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sigB64 = toBase64UrlNoPad(await crypto.subtle.sign('HMAC', key, data));
  return `\( {sessionId}. \){timestamp}.${sigB64}`;
}

export async function verifySessionToken(secret, token, maxAgeSeconds = 3600) {
  if (typeof token !== 'string') return { valid: false };
  const parts = token.split('.');
  if (parts.length !== 3) return { valid: false };
  const [sessionId, tsStr, signature] = parts;
  const timestamp = parseInt(tsStr, 10);
  if (!Number.isFinite(timestamp)) return { valid: false };
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > maxAgeSeconds) return { valid: false };
  const expectedToken = await signSessionToken(secret, sessionId, timestamp);
  const expectedSig = expectedToken.split('.')[2];
  if (!constantTimeCompare(signature, expectedSig)) return { valid: false };
  return { valid: true, sessionId, timestamp };
}

/** Header: [1 type][2 streamId BE][1 flags][4 len BE][payload] */
export function encodeFrame(type, streamId = 0, flags = 0, payload = new Uint8Array(0)) {
  const payloadBytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload || 0);
  if (payloadBytes.byteLength > MAX_FRAME_PAYLOAD_SIZE) {
    throw new RangeError('Frame payload too large');
  }
  const buffer = new Uint8Array(HEADER_SIZE + payloadBytes.byteLength);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  view.setUint8(0, type & 0xff);
  view.setUint16(1, streamId & 0xffff, false);
  view.setUint8(3, flags & 0xff);
  view.setUint32(4, payloadBytes.byteLength >>> 0, false);
  if (payloadBytes.byteLength) buffer.set(payloadBytes, HEADER_SIZE);
  return buffer;
}

export function decodeFrames(buffer) {
  if (!(buffer instanceof Uint8Array)) throw new TypeError('Buffer must be Uint8Array');
  const frames = [];
  let offset = 0;
  const total = buffer.byteLength;
  while (offset + HEADER_SIZE <= total) {
    const view = new DataView(buffer.buffer, buffer.byteOffset + offset, HEADER_SIZE);
    const type = view.getUint8(0);
    const streamId = view.getUint16(1, false);
    const flags = view.getUint8(3);
    const payloadLen = view.getUint32(4, false);
    if (payloadLen > MAX_FRAME_PAYLOAD_SIZE) throw new ProtocolError('payload too large', 1009);
    if (offset + HEADER_SIZE + payloadLen > total) break;
    const payload = buffer.slice(offset + HEADER_SIZE, offset + HEADER_SIZE + payloadLen);
    frames.push({ type, streamId, flags, payload });
    offset += HEADER_SIZE + payloadLen;
  }
  const remainder = offset === total ? new Uint8Array(0) : buffer.slice(offset);
  return { frames, remainder };
}

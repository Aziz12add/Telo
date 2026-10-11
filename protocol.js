// protocol.js
// Telegram Web Proxy v1 Protocol & Frame Codec for Cloudflare Workers

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

export const MAX_FRAME_PAYLOAD_SIZE = 1024 * 1024; // 1 MiB upper bound per frame
export const HEADER_SIZE = 8;

/**
 * Parses a 32-character hex string or 'dd' prefixed 34-character hex string into 16 bytes.
 * @param {string} secretHex
 * @returns {Uint8Array}
 */
export function parseSecret(secretHex) {
  if (typeof secretHex !== 'string') {
    throw new TypeError('Secret must be a hex string');
  }
  let s = secretHex.trim().toLowerCase();
  if (s.startsWith('dd')) {
    s = s.slice(2);
  }
  if (s.length !== 32 || !/^[0-9a-f]{32}$/.test(s)) {
    throw new Error('Secret must be 32 hex chars (or dd + 32 hex chars)');
  }
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = parseInt(s.substr(i * 2, 2), 16);
  }
  return out;
}

/**
 * Encodes Uint8Array or ArrayBuffer into unpadded base64url.
 * @param {Uint8Array|ArrayBuffer} buffer
 * @returns {string}
 */
export function toBase64UrlNoPad(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Constant-time comparison of two strings or Uint8Array buffers.
 * @param {string|Uint8Array} a
 * @param {string|Uint8Array} b
 * @returns {boolean}
 */
export function constantTimeCompare(a, b) {
  if (typeof a === 'string' && typeof b === 'string') {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
  }

  const ua = a instanceof Uint8Array ? a : new TextEncoder().encode(String(a));
  const ub = b instanceof Uint8Array ? b : new TextEncoder().encode(String(b));
  if (ua.length !== ub.length) return false;
  let diff = 0;
  for (let i = 0; i < ua.length; i++) {
    diff |= ua[i] ^ ub[i];
  }
  return diff === 0;
}

/**
 * Computes the official Telegram Web Proxy bridge capability hash:
 * context = UTF-8("tdesktop-web-proxy-bridge-v1\n" + hostname)
 * bridge = base64url-nopad(HMAC-SHA256(secretBytes, context))
 *
 * Known test vector:
 * hostname: "proxy.example.com"
 * secret: "000102030405060708090a0b0c0d0e0f"
 * Output: "MHLEY5PmW1GWqJkSrlmJpvJUiLhBH_QKy6yKg8a0JPk"
 *
 * @param {Uint8Array|string} secret
 * @param {string} hostname
 * @returns {Promise<string>}
 */
export async function computeBridgeCapability(secret, hostname) {
  const secretBytes = typeof secret === 'string' ? parseSecret(secret) : secret;
  const context = new TextEncoder().encode(`tdesktop-web-proxy-bridge-v1\n${hostname.trim().toLowerCase()}`);

  const key = await crypto.subtle.importKey(
    'raw',
    secretBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', key, context);
  return toBase64UrlNoPad(signature);
}

/**
 * Verifies if the provided bridge capability string matches the expected host and secret.
 * @param {string} providedBridge
 * @param {Uint8Array|string} secret
 * @param {string} hostname
 * @returns {Promise<boolean>}
 */
export async function verifyBridgeCapability(providedBridge, secret, hostname) {
  const expected = await computeBridgeCapability(secret, hostname);
  return constantTimeCompare(providedBridge, expected);
}

/**
 * Signs a session bootstrap token using HMAC-SHA256.
 * format: <sessionId>.<timestamp>.<base64url-signature>
 * @param {Uint8Array|string} secret
 * @param {string} sessionId
 * @param {number} timestamp
 * @returns {Promise<string>}
 */
export async function signSessionToken(secret, sessionId, timestamp) {
  const secretBytes = typeof secret === 'string' ? parseSecret(secret) : secret;
  const data = new TextEncoder().encode(`session-v1\n${sessionId}\n${timestamp}`);

  const key = await crypto.subtle.importKey(
    'raw',
    secretBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const sig = await crypto.subtle.sign('HMAC', key, data);
  const sigB64 = toBase64UrlNoPad(sig);
  return `${sessionId}.${timestamp}.${sigB64}`;
}

/**
 * Verifies HMAC signed session token with constant-time equality and expiration check.
 * @param {Uint8Array|string} secret
 * @param {string} token
 * @param {number} [maxAgeSeconds=3600]
 * @returns {Promise<{ valid: boolean, sessionId?: string, timestamp?: number }>}
 */
export async function verifySessionToken(secret, token, maxAgeSeconds = 3600) {
  if (typeof token !== 'string') {
    return { valid: false };
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    return { valid: false };
  }
  const [sessionId, tsStr, signature] = parts;
  const timestamp = parseInt(tsStr, 10);
  if (!Number.isFinite(timestamp)) {
    return { valid: false };
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > maxAgeSeconds) {
    return { valid: false };
  }

  const expectedToken = await signSessionToken(secret, sessionId, timestamp);
  const expectedSig = expectedToken.split('.')[2];

  if (!constantTimeCompare(signature, expectedSig)) {
    return { valid: false };
  }

  return { valid: true, sessionId, timestamp };
}

/**
 * Encodes a binary frame in Big-Endian:
 * [1B type][2B streamId][1B flags][4B payloadLength][payload]
 *
 * @param {number} type - FRAME_TYPES
 * @param {number} streamId - 16-bit uint (0-65535)
 * @param {number} flags - 8-bit uint (0-255)
 * @param {Uint8Array} [payload=new Uint8Array(0)]
 * @returns {Uint8Array}
 */
export function encodeFrame(type, streamId, flags = 0, payload = new Uint8Array(0)) {
  const payloadBytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload || 0);
  const payloadLen = payloadBytes.byteLength;

  if (payloadLen > MAX_FRAME_PAYLOAD_SIZE) {
    throw new RangeError(`Frame payload size ${payloadLen} exceeds limit ${MAX_FRAME_PAYLOAD_SIZE}`);
  }

  const buffer = new Uint8Array(HEADER_SIZE + payloadLen);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  view.setUint8(0, type & 0xff);
  view.setUint16(1, streamId & 0xffff, false); // Big-Endian
  view.setUint8(3, flags & 0xff);
  view.setUint32(4, payloadLen >>> 0, false);  // Big-Endian

  if (payloadLen > 0) {
    buffer.set(payloadBytes, HEADER_SIZE);
  }

  return buffer;
}

/**
 * Decodes all complete frames from an accumulator buffer.
 * Throws RangeError if frame declares length > MAX_FRAME_PAYLOAD_SIZE.
 *
 * @param {Uint8Array} buffer
 * @returns {{ frames: Array<{ type: number, streamId: number, flags: number, payload: Uint8Array }>, remainder: Uint8Array }}
 */
export function decodeFrames(buffer) {
  if (!(buffer instanceof Uint8Array)) {
    throw new TypeError('Buffer must be an instance of Uint8Array');
  }

  const frames = [];
  let offset = 0;
  const total = buffer.byteLength;

  while (offset + HEADER_SIZE <= total) {
    const view = new DataView(buffer.buffer, buffer.byteOffset + offset, HEADER_SIZE);
    const type = view.getUint8(0);
    const streamId = view.getUint16(1, false);
    const flags = view.getUint8(3);
    const payloadLen = view.getUint32(4, false);

    if (payloadLen > MAX_FRAME_PAYLOAD_SIZE) {
      throw new RangeError(`Incoming frame payload ${payloadLen} exceeds maximum ${MAX_FRAME_PAYLOAD_SIZE}`);
    }

    if (offset + HEADER_SIZE + payloadLen > total) {
      // Incomplete frame, wait for more data
      break;
    }

    const payload = buffer.slice(offset + HEADER_SIZE, offset + HEADER_SIZE + payloadLen);
    frames.push({ type, streamId, flags, payload });
    offset += HEADER_SIZE + payloadLen;
  }

  const remainder = offset === total ? new Uint8Array(0) : buffer.slice(offset);
  return { frames, remainder };
}

// Built-in verification test vector for bridge capability calculation
export async function _testVector() {
  const host = 'proxy.example.com';
  const secret = '000102030405060708090a0b0c0d0e0f';
  const expected = 'MHLEY5PmW1GWqJkSrlmJpvJUiLhBH_QKy6yKg8a0JPk';
  const actual = await computeBridgeCapability(secret, host);
  if (actual !== expected) {
    throw new Error(`Test vector mismatch: expected ${expected}, got ${actual}`);
  }
  return true;
}

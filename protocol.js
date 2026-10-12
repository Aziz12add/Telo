// protocol.js
// Telegram WEB Proxy binary frame codec and crypto engine

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

export const MAX_DATA_CHUNK = 64 * 1024; // 64 KiB
export const CARRIER_HARD_MAX = 2 * 1024 * 1024; // 2 MiB

export class ProtocolError extends Error {
  constructor(message, code = 1002) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
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
 * Computes official Telegram Web Proxy bridge capability hash.
 * context = UTF-8("tdesktop-web-proxy-bridge-v1\n" + hostname)
 * bridge = base64url-nopad(HMAC-SHA256(secretBytes, context))
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
 * Encodes a frame with standard 8-byte header:
 * [1 byte type][2 bytes streamId BE][1 byte flags][4 bytes payloadLen BE][payload]
 *
 * @param {number} type - FRAME_TYPES
 * @param {number} [streamId=0] - 16-bit unsigned integer streamId
 * @param {number} [flags=0] - 8-bit unsigned flags
 * @param {Uint8Array} [payload=new Uint8Array(0)]
 * @returns {Uint8Array}
 */
export function encodeFrame(type, streamId = 0, flags = 0, payload = new Uint8Array(0)) {
  // Support overload: encodeFrame(type, payload)
  if (streamId instanceof Uint8Array || (typeof streamId === 'object' && streamId !== null && 'byteLength' in streamId)) {
    payload = streamId;
    streamId = 0;
    flags = 0;
  }

  const payloadBytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload || 0);
  const payloadLen = payloadBytes.byteLength;

  if (type === FRAME_TYPES.DATA && payloadLen > MAX_DATA_CHUNK) {
    throw new ProtocolError(`DATA frame payload ${payloadLen} exceeds 64KiB`, 1002);
  }

  if (payloadLen > CARRIER_HARD_MAX) {
    throw new ProtocolError(`Frame payload ${payloadLen} exceeds carrier hard max 2MiB`, 1002);
  }

  const buffer = new Uint8Array(8 + payloadLen);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  view.setUint8(0, type & 0xff);
  view.setUint16(1, streamId & 0xffff, false);
  view.setUint8(3, flags & 0xff);
  view.setUint32(4, payloadLen, false);

  if (payloadLen > 0) {
    buffer.set(payloadBytes, 8);
  }

  return buffer;
}

/**
 * Decodes a single frame from the buffer:
 * Header: [1 byte type][2 bytes streamId BE][1 byte flags][4 bytes payloadLen BE][payload]
 *
 * @param {Uint8Array} buffer
 * @returns {{ frame: { type: number, streamId: number, flags: number, payload: Uint8Array } | null, remainder: Uint8Array }}
 */
export function decodeFrame(buffer) {
  if (!(buffer instanceof Uint8Array)) {
    throw new TypeError('Buffer must be an instance of Uint8Array');
  }

  if (buffer.byteLength < 8) {
    return { frame: null, remainder: buffer };
  }

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const type = view.getUint8(0);
  const streamId = view.getUint16(1, false);
  const flags = view.getUint8(3);
  const payloadLen = view.getUint32(4, false);

  if (payloadLen > CARRIER_HARD_MAX) {
    throw new ProtocolError(`Payload length ${payloadLen} exceeds carrier hard max 2MiB`, 1002);
  }

  if (buffer.byteLength < 8 + payloadLen) {
    return { frame: null, remainder: buffer };
  }

  if (type === FRAME_TYPES.DATA && payloadLen > MAX_DATA_CHUNK) {
    throw new ProtocolError(`DATA frame payload ${payloadLen} exceeds 64KiB`, 1002);
  }

  const payload = buffer.slice(8, 8 + payloadLen);
  const remainder = buffer.slice(8 + payloadLen);

  return {
    frame: { type, streamId, flags, payload },
    remainder,
  };
}

/**
 * Decodes all complete frames available in the buffer.
 *
 * @param {Uint8Array} buffer
 * @returns {{ frames: Array<{ type: number, streamId: number, flags: number, payload: Uint8Array }>, remainder: Uint8Array }}
 */
export function decodeFrames(buffer) {
  const frames = [];
  let current = buffer;

  while (current.byteLength >= 8) {
    const { frame, remainder } = decodeFrame(current);
    if (!frame) {
      break;
    }
    frames.push(frame);
    current = remainder;
  }

  return { frames, remainder: current };
}

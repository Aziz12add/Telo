// src/worker/protocol.ts
// Official Telegram WEB Proxy v1 Protocol Codec & Cryptographic Capabilities

export const FRAME_TYPES = Object.freeze({
  OPEN: 0x01,
  DATA: 0x02,
  CLOSE: 0x03,
  WINDOW: 0x04,
  PING: 0x05,
  PONG: 0x06,
  HELLO: 0x10,
  WELCOME: 0x11,
  BYE: 0x1f,
} as const);

export type FrameType = (typeof FRAME_TYPES)[keyof typeof FRAME_TYPES];

export const MAX_DATA_CHUNK = 64 * 1024; // 64 KiB
export const CARRIER_HARD_MAX = 2 * 1024 * 1024; // 2 MiB
export const INITIAL_STREAM_WINDOW = 4 * 1024 * 1024; // 4 MiB
export const MAX_STREAMS_PER_SESSION = 32;

export interface Frame {
  type: number;
  streamId: number;
  payload: Uint8Array;
}

export class ProtocolError extends Error {
  code: number;
  constructor(message: string, code = 1002) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

/**
 * Constant-time comparison to prevent timing attacks.
 */
export function constantTimeCompare(
  a: string | Uint8Array,
  b: string | Uint8Array
): boolean {
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
 * Parses a 32-hex character secret (or prefixed with 'dd' or 'ee') into 16 bytes.
 */
export function parseSecret(secret: string | Uint8Array): Uint8Array {
  if (secret instanceof Uint8Array) {
    if (secret.length === 16) return secret;
    throw new Error('Secret byte array must be exactly 16 bytes');
  }
  if (typeof secret !== 'string') {
    throw new TypeError('Secret must be a string or Uint8Array');
  }

  let s = secret.trim().toLowerCase();
  if (s.startsWith('dd')) {
    s = s.slice(2);
  } else if (s.startsWith('ee')) {
    // Fake TLS secret: starts with ee, followed by 32 hex chars of key, then domain
    s = s.slice(2, 34);
  }

  if (s.length !== 32 || !/^[0-9a-f]{32}$/.test(s)) {
    throw new Error('Secret must be 32 hex characters (or prefixed with dd/ee)');
  }

  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Encodes Uint8Array or ArrayBuffer into unpadded base64url.
 */
export function toBase64UrlNoPad(buffer: Uint8Array | ArrayBuffer): string {
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
 * Validates and canonicalizes the request hostname.
 */
export function canonicalizeHostname(rawHost: string): string {
  if (!rawHost || typeof rawHost !== "string") {
    throw new Error("Invalid host");
  }

  const raw = rawHost.trim().toLowerCase();
  if (raw.startsWith("[") || ((raw.match(/:/g) || []).length > 1)) {
    throw new Error("IPv6 addresses are not permitted");
  }

  const clean = raw.split(":")[0].trim().replace(/\.+$/, "");
  if (!clean || clean.length < 3 || !clean.includes(".")) {
    throw new Error("Host must contain dot and be at least 3 characters");
  }

  // Reject raw IPv4
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(clean)) {
    throw new Error("Direct IP addresses are not permitted");
  }

  try {
    const url = new URL("https://" + clean);
    return url.hostname;
  } catch {
    throw new Error("Invalid URL hostname");
  }
}

/**
 * Computes official Telegram Web Proxy bridge capability hash:
 * context = UTF-8("tdesktop-web-proxy-bridge-v1\n" + hostname)
 * bridge  = base64url-nopad(HMAC-SHA256(key=secretBytes, message=context))
 */
export async function computeBridgeCapability(
  secret: Uint8Array | string,
  hostname: string
): Promise<string> {
  const canonicalHost = canonicalizeHostname(hostname);
  const secretBytes = parseSecret(secret);
  const context = new TextEncoder().encode(`tdesktop-web-proxy-bridge-v1\n${canonicalHost}`);

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
 */
export async function verifyBridgeCapability(
  providedBridge: string,
  secret: Uint8Array | string,
  hostname: string
): Promise<boolean> {
  try {
    if (!providedBridge || typeof providedBridge !== 'string') return false;
    const expected = await computeBridgeCapability(secret, hostname);
    return constantTimeCompare(providedBridge.trim(), expected);
  } catch {
    return false;
  }
}

/**
 * Signs a session token for WebSocket authentication.
 */
export async function signSessionToken(
  secret: Uint8Array | string,
  sessionId: string,
  timestamp: number
): Promise<string> {
  const secretBytes = parseSecret(secret);
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
 * Verifies signed session token.
 */
export async function verifySessionToken(
  secret: Uint8Array | string,
  token: string,
  maxAgeSeconds = 3600
): Promise<{ valid: boolean; sessionId?: string; timestamp?: number }> {
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

  try {
    const expectedToken = await signSessionToken(secret, sessionId, timestamp);
    const expectedSig = expectedToken.split('.')[2];
    if (!constantTimeCompare(signature, expectedSig)) {
      return { valid: false };
    }
    return { valid: true, sessionId, timestamp };
  } catch {
    return { valid: false };
  }
}

/**
 * Official Telegram WEB Proxy v1 Frame Encoder:
 * Header (8 bytes):
 * [type: u8 (1B)][stream_id: u24 BE (3B)][payload_length: u32 BE (4B)][payload]
 */
export function encodeFrame(
  type: number,
  streamId = 0,
  payload: Uint8Array = new Uint8Array(0)
): Uint8Array {
  const payloadBytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload || 0);
  const payloadLen = payloadBytes.byteLength;

  if (type === FRAME_TYPES.DATA && payloadLen > MAX_DATA_CHUNK) {
    throw new ProtocolError(`DATA frame payload ${payloadLen} exceeds 64KiB`, 1002);
  }

  if (payloadLen > CARRIER_HARD_MAX) {
    throw new ProtocolError(`Frame payload ${payloadLen} exceeds carrier limit 2MiB`, 1002);
  }

  const buffer = new Uint8Array(8 + payloadLen);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  // Byte 0: type (u8)
  view.setUint8(0, type & 0xff);

  // Bytes 1..3: stream_id (u24 big-endian)
  view.setUint8(1, (streamId >>> 16) & 0xff);
  view.setUint8(2, (streamId >>> 8) & 0xff);
  view.setUint8(3, streamId & 0xff);

  // Bytes 4..7: payload_length (u32 big-endian)
  view.setUint32(4, payloadLen, false);

  if (payloadLen > 0) {
    buffer.set(payloadBytes, 8);
  }

  return buffer;
}

/**
 * Decodes a single frame from the buffer according to the official Telegram WEB Proxy v1 spec.
 */
export function decodeFrame(buffer: Uint8Array): {
  frame: Frame | null;
  remainder: Uint8Array;
} {
  if (!(buffer instanceof Uint8Array)) {
    throw new TypeError('Buffer must be an instance of Uint8Array');
  }

  if (buffer.byteLength < 8) {
    return { frame: null, remainder: buffer };
  }

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const type = view.getUint8(0);
  const streamId = (((view.getUint8(1) << 16) | (view.getUint8(2) << 8) | view.getUint8(3)) >>> 0);
  const payloadLen = view.getUint32(4, false);

  if (payloadLen > CARRIER_HARD_MAX) {
    throw new ProtocolError(`Payload length ${payloadLen} exceeds carrier limit 2MiB`, 1002);
  }

  if (buffer.byteLength < 8 + payloadLen) {
    return { frame: null, remainder: buffer };
  }

  if (type === FRAME_TYPES.DATA && payloadLen > MAX_DATA_CHUNK) {
    throw new ProtocolError(`DATA frame payload ${payloadLen} exceeds 64KiB`, 1002);
  }

  const payload = buffer.subarray(8, 8 + payloadLen);
  const remainder = buffer.subarray(8 + payloadLen);

  return {
    frame: { type, streamId, payload },
    remainder,
  };
}

/**
 * Decodes all complete frames available in the buffer.
 */
export function decodeFrames(buffer: Uint8Array): {
  frames: Frame[];
  remainder: Uint8Array;
} {
  const frames: Frame[] = [];
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

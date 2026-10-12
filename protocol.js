const FRAME_TYPES = Object.freeze({
  OPEN: 1,
  DATA: 2,
  CLOSE: 3,
  WINDOW: 4,
  PING: 5,
  PONG: 6,
  HELLO: 16,
  WELCOME: 17,
  BYE: 31
});
const MAX_DATA_CHUNK = 64 * 1024;
const CARRIER_HARD_MAX = 2 * 1024 * 1024;
const INITIAL_STREAM_WINDOW = 4 * 1024 * 1024;
const MAX_STREAMS_PER_SESSION = 32;
class ProtocolError extends Error {
  constructor(message, code = 1002) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}
function constantTimeCompare(a, b) {
  if (typeof a === "string" && typeof b === "string") {
    if (a.length !== b.length) return false;
    let diff2 = 0;
    for (let i = 0; i < a.length; i++) {
      diff2 |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff2 === 0;
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
function parseSecret(secret) {
  if (secret instanceof Uint8Array) {
    if (secret.length === 16) return secret;
    throw new Error("Secret byte array must be exactly 16 bytes");
  }
  if (typeof secret !== "string") {
    throw new TypeError("Secret must be a string or Uint8Array");
  }
  let s = secret.trim().toLowerCase();
  if (s.startsWith("dd")) {
    s = s.slice(2);
  } else if (s.startsWith("ee")) {
    s = s.slice(2, 34);
  }
  if (s.length !== 32 || !/^[0-9a-f]{32}$/.test(s)) {
    throw new Error("Secret must be 32 hex characters (or prefixed with dd/ee)");
  }
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
function toBase64UrlNoPad(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function canonicalizeHostname(rawHost) {
  if (!rawHost || typeof rawHost !== "string") {
    throw new Error("Invalid host");
  }
  const raw = rawHost.trim().toLowerCase();
  if (raw.startsWith("[") || (raw.match(/:/g) || []).length > 1) {
    throw new Error("IPv6 addresses are not permitted");
  }
  const clean = raw.split(":")[0].trim().replace(/\.+$/, "");
  if (!clean || clean.length < 3 || !clean.includes(".")) {
    throw new Error("Host must contain dot and be at least 3 characters");
  }
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
async function computeBridgeCapability(secret, hostname) {
  const canonicalHost = canonicalizeHostname(hostname);
  const secretBytes = parseSecret(secret);
  const context = new TextEncoder().encode(`tdesktop-web-proxy-bridge-v1
${canonicalHost}`);
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, context);
  return toBase64UrlNoPad(signature);
}
async function verifyBridgeCapability(providedBridge, secret, hostname) {
  try {
    if (!providedBridge || typeof providedBridge !== "string") return false;
    const expected = await computeBridgeCapability(secret, hostname);
    return constantTimeCompare(providedBridge.trim(), expected);
  } catch {
    return false;
  }
}
async function signSessionToken(secret, sessionId, timestamp) {
  const secretBytes = parseSecret(secret);
  const data = new TextEncoder().encode(`session-v1
${sessionId}
${timestamp}`);
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, data);
  const sigB64 = toBase64UrlNoPad(sig);
  return `${sessionId}.${timestamp}.${sigB64}`;
}
async function verifySessionToken(secret, token, maxAgeSeconds = 3600) {
  if (typeof token !== "string") {
    return { valid: false };
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    return { valid: false };
  }
  const [sessionId, tsStr, signature] = parts;
  const timestamp = parseInt(tsStr, 10);
  if (!Number.isFinite(timestamp)) {
    return { valid: false };
  }
  const now = Math.floor(Date.now() / 1e3);
  if (Math.abs(now - timestamp) > maxAgeSeconds) {
    return { valid: false };
  }
  try {
    const expectedToken = await signSessionToken(secret, sessionId, timestamp);
    const expectedSig = expectedToken.split(".")[2];
    if (!constantTimeCompare(signature, expectedSig)) {
      return { valid: false };
    }
    return { valid: true, sessionId, timestamp };
  } catch {
    return { valid: false };
  }
}
function encodeFrame(type, streamId = 0, payload = new Uint8Array(0)) {
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
  view.setUint8(0, type & 255);
  view.setUint8(1, streamId >>> 16 & 255);
  view.setUint8(2, streamId >>> 8 & 255);
  view.setUint8(3, streamId & 255);
  view.setUint32(4, payloadLen, false);
  if (payloadLen > 0) {
    buffer.set(payloadBytes, 8);
  }
  return buffer;
}
function decodeFrame(buffer) {
  if (!(buffer instanceof Uint8Array)) {
    throw new TypeError("Buffer must be an instance of Uint8Array");
  }
  if (buffer.byteLength < 8) {
    return { frame: null, remainder: buffer };
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const type = view.getUint8(0);
  const streamId = (view.getUint8(1) << 16 | view.getUint8(2) << 8 | view.getUint8(3)) >>> 0;
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
    remainder
  };
}
function decodeFrames(buffer) {
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
export {
  CARRIER_HARD_MAX,
  FRAME_TYPES,
  INITIAL_STREAM_WINDOW,
  MAX_DATA_CHUNK,
  MAX_STREAMS_PER_SESSION,
  ProtocolError,
  canonicalizeHostname,
  computeBridgeCapability,
  constantTimeCompare,
  decodeFrame,
  decodeFrames,
  encodeFrame,
  parseSecret,
  signSessionToken,
  toBase64UrlNoPad,
  verifyBridgeCapability,
  verifySessionToken
};

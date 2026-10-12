// protocol.js
// Telegram WEB Proxy v1 binary frame codec and crypto engine
// Reference: telegramdesktop/tproxy-server@52a5feb7

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
 * Encodes a frame into binary: [4-byte length][1-byte type][payload]
 * ALL integers in Big-Endian (littleEndian = false).
 * Length includes 1-byte type + payload.length.
 *
 * @param {number} type - FRAME_TYPES
 * @param {Uint8Array} [payload=new Uint8Array(0)]
 * @returns {Uint8Array}
 */
export function encodeFrame(type, payload = new Uint8Array(0)) {
  const payloadBytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload || 0);
  const payloadLen = payloadBytes.byteLength;

  if (type === FRAME_TYPES.DATA && payloadLen > MAX_DATA_CHUNK) {
    throw new ProtocolError(`DATA frame payload ${payloadLen} exceeds 64KiB`, 1002);
  }

  const frameLen = 1 + payloadLen;
  if (frameLen > CARRIER_HARD_MAX) {
    throw new ProtocolError(`Frame size ${frameLen} exceeds carrier hard max 2MiB`, 1002);
  }

  const buffer = new Uint8Array(4 + frameLen);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  view.setUint32(0, frameLen, false); // Big-Endian 4-byte length
  view.setUint8(4, type & 0xff);       // 1-byte type

  if (payloadLen > 0) {
    buffer.set(payloadBytes, 5);
  }

  return buffer;
}

/**
 * Decodes a single frame from the buffer: [4-byte length][1-byte type][payload]
 * ALL integers in Big-Endian (littleEndian = false).
 *
 * @param {Uint8Array} buffer
 * @returns {{ frame: { type: number, payload: Uint8Array } | null, remainder: Uint8Array }}
 */
export function decodeFrame(buffer) {
  if (!(buffer instanceof Uint8Array)) {
    throw new TypeError('Buffer must be an instance of Uint8Array');
  }

  if (buffer.byteLength < 4) {
    return { frame: null, remainder: buffer };
  }

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const frameLen = view.getUint32(0, false); // Big-Endian length of (type + payload)

  if (frameLen === 0) {
    throw new ProtocolError('Invalid frame length: 0', 1002);
  }

  if (frameLen > CARRIER_HARD_MAX) {
    throw new ProtocolError(`Frame length ${frameLen} exceeds carrier hard max 2MiB`, 1002);
  }

  if (buffer.byteLength < 4 + frameLen) {
    // Incomplete frame, wait for more data
    return { frame: null, remainder: buffer };
  }

  const type = view.getUint8(4);
  const payloadLen = frameLen - 1;

  if (type === FRAME_TYPES.DATA && payloadLen > MAX_DATA_CHUNK) {
    throw new ProtocolError(`DATA frame payload ${payloadLen} exceeds 64KiB`, 1002);
  }

  const payload = buffer.slice(5, 5 + payloadLen);
  const remainder = buffer.slice(4 + frameLen);

  return {
    frame: { type, payload },
    remainder,
  };
}

/**
 * Decodes all complete frames available in the buffer.
 *
 * @param {Uint8Array} buffer
 * @returns {{ frames: Array<{ type: number, payload: Uint8Array }>, remainder: Uint8Array }}
 */
export function decodeFrames(buffer) {
  const frames = [];
  let current = buffer;

  while (current.byteLength >= 4) {
    const { frame, remainder } = decodeFrame(current);
    if (!frame) {
      break;
    }
    frames.push(frame);
    current = remainder;
  }

  return { frames, remainder: current };
}

/**
 * Creates an independent AES-256-CTR streaming context.
 * Maintains counter state and keystream offset continuously across arbitrary fragmentation.
 * NEVER resets counter across DATA boundaries.
 *
 * @param {Uint8Array} key - 32-byte AES key
 * @param {Uint8Array} iv - 16-byte initial counter
 * @returns {{
 *   update: (data: Uint8Array) => Promise<Uint8Array>,
 *   encrypt: (data: Uint8Array) => Promise<Uint8Array>,
 *   decrypt: (data: Uint8Array) => Promise<Uint8Array>
 * }}
 */
export function createCtrContext(key, iv) {
  if (key.byteLength !== 32) {
    throw new Error('AES-256-CTR requires 32-byte key');
  }
  if (iv.byteLength !== 16) {
    throw new Error('AES-256-CTR requires 16-byte IV');
  }

  const keyBytes = new Uint8Array(key);
  const counter = new Uint8Array(iv);
  let keystreamBuffer = new Uint8Array(0);
  let keystreamOffset = 0;
  let cryptoKeyPromise = null;

  function getCryptoKey() {
    if (!cryptoKeyPromise) {
      cryptoKeyPromise = crypto.subtle.importKey(
        'raw',
        keyBytes,
        { name: 'AES-CTR', length: 256 },
        false,
        ['encrypt']
      );
    }
    return cryptoKeyPromise;
  }

  function incrementCounter() {
    for (let i = 15; i >= 0; i--) {
      counter[i] = (counter[i] + 1) & 0xff;
      if (counter[i] !== 0) break;
    }
  }

  async function generateKeystreamBlocks(blockCount = 64) {
    const cryptoKey = await getCryptoKey();
    const zeros = new Uint8Array(blockCount * 16);
    const startingCounter = new Uint8Array(counter);

    // Advance counter for the requested number of blocks
    for (let b = 0; b < blockCount; b++) {
      incrementCounter();
    }

    const encrypted = await crypto.subtle.encrypt(
      {
        name: 'AES-CTR',
        counter: startingCounter,
        length: 64,
      },
      cryptoKey,
      zeros
    );

    keystreamBuffer = new Uint8Array(encrypted);
    keystreamOffset = 0;
  }

  async function processStream(data) {
    const input = data instanceof Uint8Array ? data : new Uint8Array(data);
    const output = new Uint8Array(input.byteLength);

    for (let i = 0; i < input.byteLength; i++) {
      if (keystreamOffset >= keystreamBuffer.byteLength) {
        await generateKeystreamBlocks(64);
      }
      output[i] = input[i] ^ keystreamBuffer[keystreamOffset++];
    }

    return output;
  }

  return {
    update: processStream,
    encrypt: processStream,
    decrypt: processStream,
  };
}

/**
 * Creates 4 independent AES-256-CTR contexts per stream:
 * 1. outerClientDecrypt: Outer MTProxy layer client -> server
 * 2. innerClientEncrypt: Inner Telegram obfuscation layer client -> server
 * 3. innerServerDecrypt: Inner Telegram obfuscation layer server -> client
 * 4. outerServerEncrypt: Outer MTProxy layer server -> client
 */
export function createStreamCryptoContexts(keys) {
  return {
    outerClientDecrypt: createCtrContext(keys.clientDecryptKey, keys.clientDecryptIv),
    innerClientEncrypt: createCtrContext(keys.upstreamEncryptKey, keys.upstreamEncryptIv),
    innerServerDecrypt: createCtrContext(keys.upstreamDecryptKey, keys.upstreamDecryptIv),
    outerServerEncrypt: createCtrContext(keys.clientEncryptKey, keys.clientEncryptIv),
  };
}

// Unit test: encodes then decodes HELLO and checks length
export async function _testProtocol() {
  const helloPayload = new Uint8Array([0xaa, 0xbb, 0xcc]);
  const encoded = encodeFrame(FRAME_TYPES.HELLO, helloPayload);

  // [4-byte length = 4][1-byte type = 0x01][3-byte payload] = 8 bytes total
  if (encoded.byteLength !== 8) {
    throw new Error(`Expected 8 bytes, got ${encoded.byteLength}`);
  }

  const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
  const frameLen = view.getUint32(0, false);
  if (frameLen !== 4) {
    throw new Error(`Expected frame length 4, got ${frameLen}`);
  }

  const { frame, remainder } = decodeFrame(encoded);
  if (!frame) {
    throw new Error('Failed to decode frame');
  }
  if (frame.type !== FRAME_TYPES.HELLO) {
    throw new Error(`Expected type 0x01, got ${frame.type}`);
  }
  if (frame.payload.byteLength !== 3) {
    throw new Error(`Expected payload length 3, got ${frame.payload.byteLength}`);
  }
  if (frame.payload[0] !== 0xaa || frame.payload[1] !== 0xbb || frame.payload[2] !== 0xcc) {
    throw new Error('Payload mismatch');
  }
  if (remainder.byteLength !== 0) {
    throw new Error(`Expected empty remainder, got ${remainder.byteLength}`);
  }

  // Test CTR context streaming continuity across chunks
  const key = new Uint8Array(32);
  const iv = new Uint8Array(16);
  key.fill(0x42);
  iv.fill(0x24);

  const enc = createCtrContext(key, iv);
  const dec = createCtrContext(key, iv);

  const chunk1 = new Uint8Array([1, 2, 3, 4, 5]);
  const chunk2 = new Uint8Array([6, 7, 8, 9, 10]);

  const cipher1 = await enc.update(chunk1);
  const cipher2 = await enc.update(chunk2);

  const plain1 = await dec.update(cipher1);
  const plain2 = await dec.update(cipher2);

  for (let i = 0; i < 5; i++) {
    if (plain1[i] !== chunk1[i] || plain2[i] !== chunk2[i]) {
      throw new Error('CTR context streaming mismatch');
    }
  }

  return true;
}

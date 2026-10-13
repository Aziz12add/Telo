// ============================================================
// Telegram WEB Proxy v1 - Binary Frame Codec
// Big-Endian, HMAC-SHA256 authenticated handshake
// ============================================================

// ---- Frame Types ----
export const enum FrameType {
  HELLO   = 0x01,
  WELCOME = 0x02,
  OPEN    = 0x03,
  DATA    = 0x04,
  CLOSE   = 0x05,
  PING    = 0x06,
  PONG    = 0x07,
  WINDOW  = 0x08,
}

// ---- Constants ----
const NONCE_LEN = 32;   // 32 bytes random nonce
const HMAC_LEN  = 32;   // SHA-256 output

// ---- Helpers (Big-Endian) ----
const beU32 = (v: number): Uint8Array => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v, false);
  return b;
};

const readU32 = (b: Uint8Array, o: number): number =>
  new DataView(b.buffer, b.byteOffset + o).getUint32(0, false);

const concat = (...arrs: Uint8Array[]): Uint8Array => {
  const total = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
};

// ---- Random ----
export const randomBytes = (n: number): Uint8Array =>
  crypto.getRandomValues(new Uint8Array(n));

// ---- HMAC-SHA256 ----
export const hmacSha256 = async (
  key: Uint8Array,
  data: Uint8Array
): Promise<Uint8Array> => {
  const cryptoKey = await crypto.subtle.importKey(
    'raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, data);
  return new Uint8Array(sig);
};

// ---- Secret Decoding ----
// Telegram sends secret as 32-char hex string.
// Internally it's used as 16 raw bytes (hex-decoded).
export const decodeSecret = (hex: string): Uint8Array => {
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) {
    throw new Error('Secret must be 32 hex chars');
  }
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
};

// ---- Frame Header ----
// [length: u32 BE][type: u32 BE][payload...]
// length = payload length (NOT including 8-byte header)
const frame = (type: FrameType, payload: Uint8Array): Uint8Array =>
  concat(beU32(payload.length), beU32(type), payload);

// ============================================================
// Frame Builders
// ============================================================
export const buildHello = (nonce: Uint8Array): Uint8Array =>
  frame(FrameType.HELLO, nonce);

// WELCOME = [nonce:32][server_nonce:32][hmac:32]
// HMAC key = secret, data = nonce || server_nonce
export const buildWelcome = async (
  clientNonce: Uint8Array,
  secret: Uint8Array
): Promise<Uint8Array> => {
  const serverNonce = randomBytes(NONCE_LEN);
  const hmac = await hmacSha256(
    secret,
    concat(clientNonce, serverNonce)
  );
  return frame(
    FrameType.WELCOME,
    concat(clientNonce, serverNonce, hmac)
  );
};

// OPEN = [stream_id:u32][dc_id:u32][payload...]
export const buildOpen = (
  streamId: number,
  dcId: number,
  payload: Uint8Array = new Uint8Array(0)
): Uint8Array =>
  frame(
    FrameType.OPEN,
    concat(beU32(streamId), beU32(dcId), payload)
  );

// DATA = [stream_id:u32][payload...]
export const buildData = (
  streamId: number,
  payload: Uint8Array
): Uint8Array =>
  frame(FrameType.DATA, concat(beU32(streamId), payload));

// CLOSE = [stream_id:u32][error_code:u32]
export const buildClose = (
  streamId: number,
  errorCode: number = 0
): Uint8Array =>
  frame(
    FrameType.CLOSE,
    concat(beU32(streamId), beU32(errorCode))
  );

// PING = empty
export const buildPing = (): Uint8Array =>
  frame(FrameType.PING, new Uint8Array(0));

// PONG = empty
export const buildPong = (): Uint8Array =>
  frame(FrameType.PONG, new Uint8Array(0));

// WINDOW = [stream_id:u32][window_size:u32]
export const buildWindow = (
  streamId: number,
  windowSize: number
): Uint8Array =>
  frame(
    FrameType.WINDOW,
    concat(beU32(streamId), beU32(windowSize))
  );

// ============================================================
// Frame Parser
// ============================================================
export interface ParsedFrame {
  type: FrameType;
  payload: Uint8Array;
  // Decoded conveniences:
  streamId?: number;
  dcId?: number;
  nonce?: Uint8Array;
  serverNonce?: Uint8Array;
  hmac?: Uint8Array;
  errorCode?: number;
  windowSize?: number;
}

// Read one frame from buffer. Returns null if not enough bytes.
export const parseFrame = (
  buf: Uint8Array
): { frame: ParsedFrame; consumed: number } | null => {
  if (buf.length < 8) return null;
  const payloadLen = readU32(buf, 0);
  const type = readU32(buf, 4);
  const total = 8 + payloadLen;
  if (buf.length < total) return null;

  const payload = buf.subarray(8, total);
  const out: ParsedFrame = { type, payload };

  switch (type) {
    case FrameType.HELLO:
      out.nonce = payload.subarray(0, NONCE_LEN);
      break;
    case FrameType.WELCOME:
      out.nonce       = payload.subarray(0, NONCE_LEN);
      out.serverNonce = payload.subarray(NONCE_LEN, NONCE_LEN * 2);
      out.hmac        = payload.subarray(NONCE_LEN * 2, NONCE_LEN * 2 + HMAC_LEN);
      break;
    case FrameType.OPEN:
      out.streamId = readU32(payload, 0);
      out.dcId     = readU32(payload, 4);
      break;
    case FrameType.DATA:
      out.streamId = readU32(payload, 0);
      // actual data starts at offset 4
      break;
    case FrameType.CLOSE:
      out.streamId  = readU32(payload, 0);
      out.errorCode = readU32(payload, 4);
      break;
    case FrameType.WINDOW:
      out.streamId   = readU32(payload, 0);
      out.windowSize = readU32(payload, 4);
      break;
    // PING/PONG: no fields
  }
  return { frame: out, consumed: total };
};

// Strip stream_id from DATA payload
export const dataPayload = (f: ParsedFrame): Uint8Array =>
  f.payload.subarray(4);

// ============================================================
// Telegram DC Addresses
// ============================================================
export const DC_ADDRESSES: Record<number, string> = {
  1: '149.154.175.50',
  2: '149.154.167.51',
  3: '149.154.175.100',
  4: '149.154.167.91',
  5: '91.108.56.130',
};

export const DC_PORT = 443;

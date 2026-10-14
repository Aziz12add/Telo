// ============================================================
// Telegram WEB proxy v1 - shared frame codec + bridge capability
// Spec: telegramdesktop/tproxy-server PROTOCOL.md
//
// Frame: type:u8 | stream_id:u24 (BE) | payload_length:u32 (BE) | payload
// All integers are unsigned, big-endian.
// ============================================================

export const FrameType = {
  OPEN:    0x01, // client -> relay, stream != 0, empty payload
  DATA:    0x02, // both,            stream != 0, non-empty opaque payload
  CLOSE:   0x03, // both,            stream != 0, empty payload (abort)
  WINDOW:  0x04, // both,            stream != 0, payload = u32 delta (> 0)
  PING:    0x05, // relay -> client, stream == 0, opaque echo token
  PONG:    0x06, // client -> relay, stream == 0, exact echo token
  HELLO:   0x10, // client -> relay, stream == 0, payload = 0x01
  WELCOME: 0x11, // relay -> client, stream == 0, empty payload
  BYE:     0x1f, // relay -> client, stream == 0, optional short reason
} as const;
export type FrameType = (typeof FrameType)[keyof typeof FrameType];

// ---- Limits from the spec ----
export const HEADER_LEN = 8;
export const MAX_PAYLOAD = 1 << 20;            // 1 MiB per frame
export const MAX_DATA_CHUNK = 64 * 1024;       // relay DATA chunk size
export const MAX_FRAMES_PER_BATCH = 4096;      // frames per carrier body/message
export const INITIAL_WINDOW = 4 * 1024 * 1024; // initial credit per stream/direction
export const MAX_STREAM_ID = 0xffffff;         // u24

const EMPTY = new Uint8Array(0);
const KNOWN_TYPES = new Set<number>(Object.values(FrameType));

export interface Frame {
  type: FrameType;
  streamId: number;
  payload: Uint8Array; // a view into the input buffer (not a copy)
}

// ============================================================
// Encoding
// ============================================================
const encode = (
  type: FrameType,
  streamId: number,
  payload: Uint8Array = EMPTY
): Uint8Array => {
  if (!Number.isInteger(streamId) || streamId < 0 || streamId > MAX_STREAM_ID) {
    throw new RangeError(`stream id out of range: ${streamId}`);
  }
  if (payload.length > MAX_PAYLOAD) {
    throw new RangeError(`payload too large: ${payload.length}`);
  }
  const out = new Uint8Array(HEADER_LEN + payload.length);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, type);
  dv.setUint8(1, (streamId >>> 16) & 0xff);
  dv.setUint8(2, (streamId >>> 8) & 0xff);
  dv.setUint8(3, streamId & 0xff);
  dv.setUint32(4, payload.length, false);
  out.set(payload, HEADER_LEN);
  return out;
};

export const buildHello = (): Uint8Array =>
  encode(FrameType.HELLO, 0, Uint8Array.of(0x01));

export const buildWelcome = (): Uint8Array => encode(FrameType.WELCOME, 0);

export const buildOpen = (streamId: number): Uint8Array =>
  encode(FrameType.OPEN, requireStream(streamId));

export const buildData = (streamId: number, payload: Uint8Array): Uint8Array => {
  if (payload.length === 0) throw new RangeError('DATA payload must be non-empty');
  return encode(FrameType.DATA, requireStream(streamId), payload);
};

/** Split a large buffer into DATA frames of at most 64 KiB each. */
export const buildDataChunks = (
  streamId: number,
  payload: Uint8Array
): Uint8Array[] => {
  const frames: Uint8Array[] = [];
  for (let o = 0; o < payload.length; o += MAX_DATA_CHUNK) {
    frames.push(buildData(streamId, payload.subarray(o, o + MAX_DATA_CHUNK)));
  }
  return frames;
};

export const buildClose = (streamId: number): Uint8Array =>
  encode(FrameType.CLOSE, requireStream(streamId));

export const buildWindow = (streamId: number, delta: number): Uint8Array => {
  if (!Number.isInteger(delta) || delta <= 0 || delta > 0xffffffff) {
    throw new RangeError(`WINDOW delta must be a positive u32: ${delta}`);
  }
  const p = new Uint8Array(4);
  new DataView(p.buffer).setUint32(0, delta, false);
  return encode(FrameType.WINDOW, requireStream(streamId), p);
};

export const buildPing = (token: Uint8Array): Uint8Array =>
  encode(FrameType.PING, 0, token);

export const buildPong = (token: Uint8Array): Uint8Array =>
  encode(FrameType.PONG, 0, token);

export const buildBye = (reason: Uint8Array = EMPTY): Uint8Array =>
  encode(FrameType.BYE, 0, reason);

const requireStream = (id: number): number => {
  if (id === 0) throw new RangeError('stream id must be non-zero');
  return id;
};

// ============================================================
// Parsing
// ============================================================

/**
 * Parse one frame at `offset`. Returns null if the buffer does not yet hold a
 * complete frame (streaming use). Throws on malformed headers.
 */
export const parseFrame = (
  buf: Uint8Array,
  offset = 0
): { frame: Frame; consumed: number } | null => {
  if (buf.length - offset < HEADER_LEN) return null;

  const dv = new DataView(buf.buffer, buf.byteOffset + offset, HEADER_LEN);
  const type = dv.getUint8(0);
  const streamId =
    (dv.getUint8(1) << 16) | (dv.getUint8(2) << 8) | dv.getUint8(3);
  const len = dv.getUint32(4, false);

  if (!KNOWN_TYPES.has(type)) {
    throw new Error(`unknown frame type 0x${type.toString(16)}`);
  }
  if (len > MAX_PAYLOAD) throw new Error(`frame too large: ${len}`);

  const total = HEADER_LEN + len;
  if (buf.length - offset < total) return null;

  return {
    frame: {
      type: type as FrameType,
      streamId,
      payload: buf.subarray(offset + HEADER_LEN, offset + total),
    },
    consumed: total,
  };
};

export type Origin = 'from-client' | 'from-relay';

const FROM_CLIENT = new Set<number>([
  FrameType.OPEN, FrameType.DATA, FrameType.CLOSE,
  FrameType.WINDOW, FrameType.PONG, FrameType.HELLO,
]);
const FROM_RELAY = new Set<number>([
  FrameType.DATA, FrameType.CLOSE, FrameType.WINDOW,
  FrameType.PING, FrameType.WELCOME, FrameType.BYE,
]);

/** Enforce the per-type rules of the spec's frame table. Throws on violation. */
export const validateFrame = (f: Frame, origin: Origin): void => {
  const allowed = origin === 'from-client' ? FROM_CLIENT : FROM_RELAY;
  if (!allowed.has(f.type)) {
    throw new Error(`frame type 0x${f.type.toString(16)} not allowed ${origin}`);
  }
  const zeroStream = f.streamId === 0;
  switch (f.type) {
    case FrameType.OPEN:
    case FrameType.CLOSE:
      if (zeroStream || f.payload.length !== 0) throw new Error('bad OPEN/CLOSE');
      break;
    case FrameType.DATA:
      if (zeroStream || f.payload.length === 0) throw new Error('bad DATA');
      break;
    case FrameType.WINDOW:
      if (zeroStream || f.payload.length !== 4 || readWindowDelta(f) === 0) {
        throw new Error('bad WINDOW');
      }
      break;
    case FrameType.PING:
    case FrameType.PONG:
    case FrameType.BYE:
      if (!zeroStream) throw new Error('PING/PONG/BYE must use stream 0');
      break;
    case FrameType.HELLO:
      if (!zeroStream || f.payload.length !== 1 || f.payload[0] !== 0x01) {
        throw new Error('bad HELLO');
      }
      break;
    case FrameType.WELCOME:
      if (!zeroStream || f.payload.length !== 0) throw new Error('bad WELCOME');
      break;
  }
};

export const readWindowDelta = (f: Frame): number =>
  new DataView(f.payload.buffer, f.payload.byteOffset, 4).getUint32(0, false);

/**
 * Parse a complete carrier batch (one WebSocket binary message / HTTP body).
 * Every byte must belong to a complete, valid frame.
 */
export const parseBatch = (buf: Uint8Array, origin: Origin): Frame[] => {
  const frames: Frame[] = [];
  let off = 0;
  while (off < buf.length) {
    const r = parseFrame(buf, off);
    if (!r) throw new Error('truncated frame in batch');
    validateFrame(r.frame, origin);
    frames.push(r.frame);
    if (frames.length > MAX_FRAMES_PER_BATCH) throw new Error('too many frames');
    off += r.consumed;
  }
  return frames;
};

export const concat = (...arrs: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(arrs.reduce((s, a) => s + a.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
};

// ============================================================
// Secret + bridge capability
// ============================================================

/**
 * Client-facing secret: 32 hex chars (16 bytes), or "dd" + 32 hex chars when
 * random-padding mode is selected. The leading dd byte is KEPT in the bytes.
 */
export const decodeSecret = (hex: string): Uint8Array => {
  if (!/^(dd)?[0-9a-fA-F]{32}$/.test(hex)) {
    throw new Error('secret must be 32 hex chars, optionally prefixed with dd');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};

export const hmacSha256 = async (
  key: Uint8Array,
  data: Uint8Array
): Promise<Uint8Array> => {
  const k = await crypto.subtle.importKey(
    'raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data as BufferSource));
};

const b64url = (b: Uint8Array): string => {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** URL is https://H/?bridge=<capability>. H = canonical lowercase ASCII/IDNA host. */
export const bridgeCapability = async (
  secret: Uint8Array,
  hostname: string
): Promise<string> => {
  const host = new URL(`https://${hostname}`).hostname; // lowercases + punycode
  const ctx = new TextEncoder().encode(`tdesktop-web-proxy-bridge-v1\n${host}`);
  return b64url(await hmacSha256(secret, ctx));
};

/** Constant-time string comparison (e.g. for the ?bridge= parameter). */
export const safeEqual = (a: string, b: string): boolean => {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
};

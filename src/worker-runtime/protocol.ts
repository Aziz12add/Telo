/**
 * Binary Framing & Bridge Protocol
 * Implements high-throughput binary framing between Telegram Web/Bridge clients
 * and Cloudflare Workers Durable Objects.
 */

export const FRAME_TYPES = {
  HELLO: 0x01,       // Client hello with auth token + target DC
  WELCOME: 0x02,     // Server welcome with session parameters & window size
  DATA: 0x03,        // Framed MTProto packet payload
  WINDOW_UPDATE: 0x04, // Flow control credit update
  PING: 0x05,        // Heartbeat ping
  PONG: 0x06,        // Heartbeat pong
  CLOSE: 0x0f        // Graceful stream tear down
} as const;

export interface Frame {
  type: number;
  streamId: number;
  flags: number;
  payload: Uint8Array;
}

/**
 * Encodes a structured binary frame:
 * [1B Type][2B StreamId][1B Flags][4B Payload Length (BE)][Payload Bytes]
 */
export function encodeFrame(type: number, streamId: number, flags: number, payload: Uint8Array): Uint8Array {
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

/**
 * Decodes frames from an incoming stream buffer.
 * Returns array of frames and remaining unparsed bytes.
 */
export function decodeFrames(buffer: Uint8Array): { frames: Frame[]; remainder: Uint8Array } {
  const frames: Frame[] = [];
  let offset = 0;

  while (offset + 8 <= buffer.byteLength) {
    const view = new DataView(buffer.buffer, buffer.byteOffset + offset, 8);
    const type = view.getUint8(0);
    const streamId = view.getUint16(1, false);
    const flags = view.getUint8(3);
    const payloadLen = view.getUint32(4, false);

    if (offset + 8 + payloadLen > buffer.byteLength) {
      // Frame incomplete, wait for more chunks
      break;
    }

    const payload = buffer.slice(offset + 8, offset + 8 + payloadLen);
    frames.push({ type, streamId, flags, payload });
    offset += 8 + payloadLen;
  }

  const remainder = buffer.slice(offset);
  return { frames, remainder };
}

/**
 * Creates HMAC-SHA256 signature for session bootstrap authentication
 */
export async function signSessionToken(secret: string, sessionId: string, timestamp: number): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const data = enc.encode(`telo:v2:${sessionId}:${timestamp}`);
  const signature = await crypto.subtle.sign('HMAC', key, data);
  const hashArray = Array.from(new Uint8Array(signature));
  const hex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return `${sessionId}.${timestamp}.${hex}`;
}

/**
 * Verifies HMAC-SHA256 signature for session bootstrap
 */
export async function verifySessionToken(secret: string, token: string): Promise<boolean> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const [sessionId, tsStr, signature] = parts;
    const ts = parseInt(tsStr, 10);
    const now = Math.floor(Date.now() / 1000);

    // 1-hour expiration limit on session tokens
    if (Math.abs(now - ts) > 3600) return false;

    const expected = await signSessionToken(secret, sessionId, ts);
    const expectedSig = expected.split('.')[2];

    // Constant-time compare
    if (signature.length !== expectedSig.length) return false;
    let diff = 0;
    for (let i = 0; i < signature.length; i++) {
      diff |= signature.charCodeAt(i) ^ expectedSig.charCodeAt(i);
    }
    return diff === 0;
  } catch {
    return false;
  }
}

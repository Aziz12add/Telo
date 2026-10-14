// ============================================================
// Stateless tokens, so unauthenticated probes never touch a Durable Object.
//
// bootstrap = nonce(12) | ts_seconds(u32 BE) | tag(16)      -> 32 bytes, base64url (43 chars)
// session   = sid(16) | tag(16), sid = HMAC(kSess, "sid"|bootstrap)[0..16]
//             -> the same bootstrap always yields the same session (idempotent retries)
//
// All keys are derived from the client-facing secret bytes.
// ============================================================
import { hmacSha256, concat } from './protocol';

const te = new TextEncoder();

export const BOOTSTRAP_TTL_S = 120;

export const b64urlEncode = (b: Uint8Array): string => {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export const b64urlDecode = (s: string): Uint8Array | null => {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
};

const ctEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  let d = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) d |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return d === 0;
};

const subkey = (secret: Uint8Array, label: string): Promise<Uint8Array> =>
  hmacSha256(secret, te.encode(`telo/${label}`));

export const mintBootstrap = async (
  secret: Uint8Array,
  nowS: number = Math.floor(Date.now() / 1000)
): Promise<string> => {
  const body = new Uint8Array(16);
  crypto.getRandomValues(body.subarray(0, 12));
  new DataView(body.buffer).setUint32(12, nowS, false);
  const tag = (await hmacSha256(await subkey(secret, 'boot'), body)).subarray(0, 16);
  return b64urlEncode(concat(body, tag));
};

/** Returns the raw 32 token bytes when valid and fresh, else null. */
export const verifyBootstrap = async (
  secret: Uint8Array,
  token: string,
  nowS: number = Math.floor(Date.now() / 1000)
): Promise<Uint8Array | null> => {
  const raw = b64urlDecode(token);
  if (!raw || raw.length !== 32) return null;
  const tag = (await hmacSha256(await subkey(secret, 'boot'), raw.subarray(0, 16))).subarray(0, 16);
  if (!ctEqual(raw.subarray(16), tag)) return null;
  const ts = new DataView(raw.buffer, raw.byteOffset + 12, 4).getUint32(0, false);
  if (nowS - ts > BOOTSTRAP_TTL_S || ts - nowS > 10) return null;
  return raw;
};

export const deriveSession = async (
  secret: Uint8Array,
  bootstrapRaw: Uint8Array
): Promise<{ token: string; id: string }> => {
  const k = await subkey(secret, 'sess');
  const sid = (await hmacSha256(k, concat(te.encode('sid'), bootstrapRaw))).subarray(0, 16);
  const tag = (await hmacSha256(k, concat(te.encode('tag'), sid))).subarray(0, 16);
  return { token: b64urlEncode(concat(sid, tag)), id: b64urlEncode(sid) };
};

/** Returns the session id (Durable Object name) when the token is genuine, else null. */
export const verifySession = async (
  secret: Uint8Array,
  token: string
): Promise<string | null> => {
  const raw = b64urlDecode(token);
  if (!raw || raw.length !== 32) return null;
  const sid = raw.subarray(0, 16);
  const k = await subkey(secret, 'sess');
  const tag = (await hmacSha256(k, concat(te.encode('tag'), sid))).subarray(0, 16);
  return ctEqual(raw.subarray(16), tag) ? b64urlEncode(sid) : null;
};

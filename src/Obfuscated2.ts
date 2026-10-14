// ============================================================
// MTProxy "obfuscated2" transport helpers for the WEB proxy relay.
//
// The Telegram app wraps every connection in the normal MTProxy transform
// (AES-256-CTR keyed from a 64-byte init packet + the proxy secret). The WEB
// proxy carries those bytes untouched. A real MTProxy would decrypt them and
// talk to the DC; in a Worker we do that ourselves:
//
//   client --[secret-keyed CTR]--> relay --[plain obfuscated2]--> Telegram DC
//
// accept()    : relay side of the client's connection (uses the secret)
// initiate()  : relay side of the DC connection (no secret) - also usable to
//               simulate a client in tests (pass the secret).
// ============================================================


const concat = (...arrs: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(arrs.reduce((s, a) => s + a.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
};

const sha256 = async (d: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', d as BufferSource));

/** Add n (a non-negative safe integer) to a 128-bit big-endian counter in place. */
const addToCounter = (c: Uint8Array, n: number): void => {
  let carry = n;
  for (let i = 15; i >= 0 && carry > 0; i--) {
    const v = c[i] + (carry % 256);
    c[i] = v & 0xff;
    carry = Math.floor(carry / 256) + (v >> 8);
  }
};

/**
 * Streaming AES-256-CTR on top of WebCrypto (which only offers one-shot CTR).
 * Keeps the counter block and the offset inside the current keystream block, so
 * arbitrary chunk sizes produce the same bytes as one continuous cipher.
 * Calls are serialized internally, so ordering is preserved.
 */
export class CtrStream {
  private key: CryptoKey;
  private counter: Uint8Array;
  private offset = 0;
  private chain: Promise<unknown> = Promise.resolve();

  private constructor(key: CryptoKey, counter: Uint8Array) {
    this.key = key;
    this.counter = counter;
  }

  static async create(rawKey: Uint8Array, iv: Uint8Array): Promise<CtrStream> {
    if (rawKey.length !== 32 || iv.length !== 16) throw new Error('bad key/iv size');
    const key = await crypto.subtle.importKey(
      'raw', rawKey as BufferSource, { name: 'AES-CTR' }, false, ['encrypt']
    );
    return new CtrStream(key, iv.slice());
  }

  /** Encrypt or decrypt (CTR is symmetric) the next `data.length` bytes of the stream. */
  process(data: Uint8Array): Promise<Uint8Array> {
    const run = async (): Promise<Uint8Array> => {
      if (data.length === 0) return new Uint8Array(0);
      const pre = this.offset;
      const input = new Uint8Array(pre + data.length); // pre zero bytes burn used keystream
      input.set(data, pre);
      const out = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: 'AES-CTR', counter: this.counter.slice(), length: 128 },
          this.key,
          input as BufferSource
        )
      );
      const total = pre + data.length;
      addToCounter(this.counter, Math.floor(total / 16));
      this.offset = total % 16;
      return out.slice(pre);
    };
    const result = this.chain.then(run);
    this.chain = result.then(() => undefined, () => undefined);
    return result;
  }
}

// ---- Secrets ----

/**
 * Client-facing secret bytes -> the 16 bytes used for key derivation.
 * (A leading 0xdd marks random-padding mode; it is not part of the key.)
 */
export const mtproxySecret = (s: Uint8Array): Uint8Array => {
  if (s.length === 17 && s[0] === 0xdd) return s.slice(1);
  if (s.length === 16) return s;
  throw new Error('unsupported secret length');
};

// ---- Init packet ----

const isTag = (t: Uint8Array): boolean =>
  t.length === 4 &&
  (t[0] === 0xef || t[0] === 0xee || t[0] === 0xdd) &&
  t[1] === t[0] && t[2] === t[0] && t[3] === t[0];

const forbiddenInit = (init: Uint8Array): boolean => {
  if (init[0] === 0xef) return true;
  const head = String.fromCharCode(init[0], init[1], init[2], init[3]);
  if (head === 'HEAD' || head === 'POST' || head === 'GET ' || head === 'OPTI') return true;
  if (isTag(init.subarray(0, 4))) return true; // 0xeeeeeeee / 0xdddddddd (0xefef.. caught above)
  return (init[4] | init[5] | init[6] | init[7]) === 0;
};

const deriveKey = async (raw32: Uint8Array, secret?: Uint8Array): Promise<Uint8Array> =>
  secret ? sha256(concat(raw32, secret)) : raw32.slice();

export interface Obfuscated2 {
  /** The 64 bytes to put on the wire first. */
  wire: Uint8Array;
  /** Encrypts what we send. */
  enc: CtrStream;
  /** Decrypts what we receive. */
  dec: CtrStream;
}

/**
 * Start an obfuscated2 connection (what a client - or our DC-side socket - does).
 * `tag` = 4 identical bytes (ef = abridged, ee = intermediate, dd = padded).
 * `dcId` = int16 (negative = media DC). `secret` = 16-byte MTProxy secret, omitted for a direct DC.
 */
export const initiate = async (
  tag: Uint8Array,
  dcId: number,
  secret?: Uint8Array
): Promise<Obfuscated2> => {
  if (!isTag(tag)) throw new Error('bad protocol tag');
  const init = new Uint8Array(64);
  do { crypto.getRandomValues(init); } while (forbiddenInit(init));
  init.set(tag, 56);
  new DataView(init.buffer).setInt16(60, dcId, true);

  const rev = init.slice(8, 56).reverse();
  const enc = await CtrStream.create(await deriveKey(init.slice(8, 40), secret), init.slice(40, 56));
  const dec = await CtrStream.create(await deriveKey(rev.slice(0, 32), secret), rev.slice(32, 48));

  const encInit = await enc.process(init); // also advances the stream past the 64 init bytes
  const wire = init.slice();
  wire.set(encInit.subarray(56, 64), 56);  // only bytes 56..63 are replaced
  return { wire, enc, dec };
};

export interface Accepted {
  tag: Uint8Array;
  /** int16 from the init packet: negative = media DC. */
  dcId: number;
  /** Decrypts bytes coming from the peer (continues after the init packet). */
  fromClient: CtrStream;
  /** Encrypts bytes going to the peer. */
  toClient: CtrStream;
}

/** Accept the first 64 bytes of an obfuscated2 connection. Throws if the secret/tag is wrong. */
export const accept = async (wire: Uint8Array, secret?: Uint8Array): Promise<Accepted> => {
  if (wire.length !== 64) throw new Error('init must be 64 bytes');
  const fromClient = await CtrStream.create(
    await deriveKey(wire.slice(8, 40), secret), wire.slice(40, 56)
  );
  const dec = await fromClient.process(wire);
  const tag = dec.slice(56, 60);
  if (!isTag(tag)) throw new Error('bad init (wrong secret?)');
  const dcId = new DataView(dec.slice(60, 62).buffer).getInt16(0, true);

  const rev = wire.slice(8, 56).reverse();
  const toClient = await CtrStream.create(
    await deriveKey(rev.slice(0, 32), secret), rev.slice(32, 48)
  );
  return { tag, dcId, fromClient, toClient };
};

export const TAG_PADDED = Uint8Array.of(0xdd, 0xdd, 0xdd, 0xdd);
export const TAG_INTERMEDIATE = Uint8Array.of(0xee, 0xee, 0xee, 0xee);
export const TAG_ABRIDGED = Uint8Array.of(0xef, 0xef, 0xef, 0xef);

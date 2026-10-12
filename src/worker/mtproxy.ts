// src/worker/mtproxy.ts
// Authentic AES-256-CTR and Telegram MTProto Obfuscated2 Handshake Implementation

// Standard AES S-Box
const SBOX = new Uint8Array([
  0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
  0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
  0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
  0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
  0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
  0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
  0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
  0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
  0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
  0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
  0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
  0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
  0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
  0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
  0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
  0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16,
]);

const RCON = new Uint32Array([
  0x00000000, 0x01000000, 0x02000000, 0x04000000, 0x08000000,
  0x10000000, 0x20000000, 0x40000000, 0x80000000, 0x1b000000, 0x36000000,
]);

function subWord(word: number): number {
  return (
    (SBOX[(word >>> 24) & 0xff] << 24) |
    (SBOX[(word >>> 16) & 0xff] << 16) |
    (SBOX[(word >>> 8) & 0xff] << 8) |
    SBOX[word & 0xff]
  );
}

function rotWord(word: number): number {
  return ((word << 8) | (word >>> 24)) >>> 0;
}

function xtime(b: number): number {
  return ((b << 1) ^ (((b >> 7) & 1) * 0x11b)) & 0xff;
}

/**
 * Authentic AES-256-CTR Implementation with full 128-bit counter
 */
export class Aes256Ctr {
  private roundKeys: Uint32Array;
  private counter: Uint8Array;
  private keystreamBlock: Uint8Array;
  private keystreamOffset: number;

  constructor(keyBytes: Uint8Array, ivBytes: Uint8Array) {
    if (keyBytes.length !== 32) {
      throw new Error(`AES-256 requires 32-byte key, got ${keyBytes.length}`);
    }
    if (ivBytes.length !== 16) {
      throw new Error(`AES-CTR requires 16-byte IV, got ${ivBytes.length}`);
    }

    this.roundKeys = this.expandKey(keyBytes);
    this.counter = new Uint8Array(16);
    this.counter.set(ivBytes);
    this.keystreamBlock = new Uint8Array(16);
    this.keystreamOffset = 16; // Force generate on first byte
  }

  private expandKey(key: Uint8Array): Uint32Array {
    // 256-bit key has 14 rounds -> 15 * 4 = 60 words
    const w = new Uint32Array(60);
    const view = new DataView(key.buffer, key.byteOffset, key.byteLength);

    for (let i = 0; i < 8; i++) {
      w[i] = view.getUint32(i * 4, false);
    }

    for (let i = 8; i < 60; i++) {
      let temp = w[i - 1];
      if (i % 8 === 0) {
        temp = (subWord(rotWord(temp)) ^ RCON[i / 8]) >>> 0;
      } else if (i % 8 === 4) {
        temp = subWord(temp) >>> 0;
      }
      w[i] = (w[i - 8] ^ temp) >>> 0;
    }

    return w;
  }

  private encryptBlock(input: Uint8Array, output: Uint8Array): void {
    const state = new Uint8Array(16);
    state.set(input);

    // Initial Round Key addition
    for (let i = 0; i < 4; i++) {
      const rk = this.roundKeys[i];
      state[i * 4] ^= (rk >>> 24) & 0xff;
      state[i * 4 + 1] ^= (rk >>> 16) & 0xff;
      state[i * 4 + 2] ^= (rk >>> 8) & 0xff;
      state[i * 4 + 3] ^= rk & 0xff;
    }

    // 13 main rounds
    for (let round = 1; round <= 13; round++) {
      // SubBytes
      for (let i = 0; i < 16; i++) {
        state[i] = SBOX[state[i]];
      }

      // ShiftRows
      const t1 = state[1];
      state[1] = state[5];
      state[5] = state[9];
      state[9] = state[13];
      state[13] = t1;

      const t2 = state[2];
      const t6 = state[6];
      state[2] = state[10];
      state[6] = state[14];
      state[10] = t2;
      state[14] = t6;

      const t3 = state[15];
      state[15] = state[11];
      state[11] = state[7];
      state[7] = state[3];
      state[3] = t3;

      // MixColumns
      for (let c = 0; c < 4; c++) {
        const idx = c * 4;
        const a0 = state[idx];
        const a1 = state[idx + 1];
        const a2 = state[idx + 2];
        const a3 = state[idx + 3];

        state[idx] = xtime(a0 ^ a1) ^ a1 ^ a2 ^ a3;
        state[idx + 1] = xtime(a1 ^ a2) ^ a2 ^ a3 ^ a0;
        state[idx + 2] = xtime(a2 ^ a3) ^ a3 ^ a0 ^ a1;
        state[idx + 3] = xtime(a3 ^ a0) ^ a0 ^ a1 ^ a2;
      }

      // AddRoundKey
      const baseRk = round * 4;
      for (let i = 0; i < 4; i++) {
        const rk = this.roundKeys[baseRk + i];
        state[i * 4] ^= (rk >>> 24) & 0xff;
        state[i * 4 + 1] ^= (rk >>> 16) & 0xff;
        state[i * 4 + 2] ^= (rk >>> 8) & 0xff;
        state[i * 4 + 3] ^= rk & 0xff;
      }
    }

    // Final round (no MixColumns)
    for (let i = 0; i < 16; i++) {
      state[i] = SBOX[state[i]];
    }

    const t1 = state[1];
    state[1] = state[5];
    state[5] = state[9];
    state[9] = state[13];
    state[13] = t1;

    const t2 = state[2];
    const t6 = state[6];
    state[2] = state[10];
    state[6] = state[14];
    state[10] = t2;
    state[14] = t6;

    const t3 = state[15];
    state[15] = state[11];
    state[11] = state[7];
    state[7] = state[3];
    state[3] = t3;

    for (let i = 0; i < 4; i++) {
      const rk = this.roundKeys[56 + i];
      state[i * 4] ^= (rk >>> 24) & 0xff;
      state[i * 4 + 1] ^= (rk >>> 16) & 0xff;
      state[i * 4 + 2] ^= (rk >>> 8) & 0xff;
      state[i * 4 + 3] ^= rk & 0xff;
    }

    output.set(state);
  }

  private incrementCounter(): void {
    // 128-bit big endian increment
    for (let i = 15; i >= 0; i--) {
      if (++this.counter[i] !== 0) {
        break;
      }
    }
  }

  /**
   * Encrypts or decrypts a stream of bytes synchronously.
   */
  public process(data: Uint8Array): Uint8Array {
    const out = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) {
      if (this.keystreamOffset === 16) {
        this.encryptBlock(this.counter, this.keystreamBlock);
        this.incrementCounter();
        this.keystreamOffset = 0;
      }
      out[i] = data[i] ^ this.keystreamBlock[this.keystreamOffset++];
    }
    return out;
  }
}

/**
 * Computes SHA-256 hash
 */
export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const hash = await crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(hash);
}

/**
 * Creates authentic Telegram MTProto Obfuscated2 contexts for direct DC communication.
 */
export async function createStreamCryptoContexts(
  secretBytes: Uint8Array,
  _dcId = 2
): Promise<{
  handshakePacket: Uint8Array;
  encryptor: Aes256Ctr;
  decryptor: Aes256Ctr;
}> {
  let handshake: Uint8Array;

  // Generate 64-byte random header complying with Telegram MTProto Obfuscated2 requirements
  while (true) {
    const bytes = new Uint8Array(64);
    crypto.getRandomValues(bytes);

    const firstByte = bytes[0];
    if (firstByte === 0xef) continue;

    const first4 = (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
    if (
      first4 === 0x44414548 || // HEAD
      first4 === 0x54534f50 || // POST
      first4 === 0x20544547 || // GET
      first4 === 0xeeeeeeee ||
      first4 === 0xdddddddd
    ) {
      continue;
    }

    const next4 = (bytes[4] << 24) | (bytes[5] << 16) | (bytes[6] << 8) | bytes[7];
    if (next4 === 0) continue;

    // Protocol tag at 56..60: 0xeeeeeeee for intermediate MTProto
    bytes[56] = 0xee;
    bytes[57] = 0xee;
    bytes[58] = 0xee;
    bytes[59] = 0xee;

    handshake = bytes;
    break;
  }

  // Derive keys and IVs
  const encryptKeyRaw = handshake.slice(8, 40);
  const encryptIv = handshake.slice(40, 56);

  const decryptKeyRaw = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    decryptKeyRaw[i] = handshake[39 - i];
  }

  const decryptIv = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    decryptIv[i] = handshake[55 - i];
  }

  // Derive final keys using secret and SHA-256
  const encKeyData = new Uint8Array(32 + secretBytes.length);
  encKeyData.set(encryptKeyRaw, 0);
  encKeyData.set(secretBytes, 32);
  const encryptKey = await sha256(encKeyData);

  const decKeyData = new Uint8Array(32 + secretBytes.length);
  decKeyData.set(decryptKeyRaw, 0);
  decKeyData.set(secretBytes, 32);
  const decryptKey = await sha256(decKeyData);

  const encryptor = new Aes256Ctr(encryptKey, encryptIv);
  const decryptor = new Aes256Ctr(decryptKey, decryptIv);

  // Encrypt the handshake header
  const encryptedHandshake = encryptor.process(handshake);

  // The 64-byte wire packet retains the first 56 bytes plain, and encrypted bytes 56..64
  const wirePacket = new Uint8Array(64);
  wirePacket.set(handshake.subarray(0, 56), 0);
  wirePacket.set(encryptedHandshake.subarray(56, 64), 56);

  return {
    handshakePacket: wirePacket,
    encryptor,
    decryptor,
  };
}

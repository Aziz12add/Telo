// test/protocol.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FRAME_TYPES,
  MAX_DATA_CHUNK,
  CARRIER_HARD_MAX,
  INITIAL_STREAM_WINDOW,
  MAX_STREAMS_PER_SESSION,
  ProtocolError,
  constantTimeCompare,
  parseSecret,
  toBase64UrlNoPad,
  canonicalizeHostname,
  computeBridgeCapability,
  verifyBridgeCapability,
  signSessionToken,
  verifySessionToken,
  encodeFrame,
  decodeFrame,
  decodeFrames,
} from '../src/worker/protocol.ts';

test('Protocol Constants conform to official Telegram WEB Proxy v1 specification', () => {
  assert.equal(FRAME_TYPES.OPEN, 0x01);
  assert.equal(FRAME_TYPES.DATA, 0x02);
  assert.equal(FRAME_TYPES.CLOSE, 0x03);
  assert.equal(FRAME_TYPES.WINDOW, 0x04);
  assert.equal(FRAME_TYPES.PING, 0x05);
  assert.equal(FRAME_TYPES.PONG, 0x06);
  assert.equal(FRAME_TYPES.HELLO, 0x10);
  assert.equal(FRAME_TYPES.WELCOME, 0x11);
  assert.equal(FRAME_TYPES.BYE, 0x1f);

  assert.equal(MAX_DATA_CHUNK, 64 * 1024);
  assert.equal(CARRIER_HARD_MAX, 2 * 1024 * 1024);
  assert.equal(INITIAL_STREAM_WINDOW, 4 * 1024 * 1024);
  assert.equal(MAX_STREAMS_PER_SESSION, 32);
});

test('Constant-time comparison prevents timing discrepancies', () => {
  assert.equal(constantTimeCompare('secret123', 'secret123'), true);
  assert.equal(constantTimeCompare('secret123', 'secret124'), false);
  assert.equal(constantTimeCompare('short', 'longer-string'), false);
  assert.equal(constantTimeCompare(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])), true);
  assert.equal(constantTimeCompare(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])), false);
  assert.equal(constantTimeCompare(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3])), false);
});

test('parseSecret parses 32-hex, dd-prefixed, and ee-prefixed secrets', () => {
  const rawHex = '00112233445566778899aabbccddeeff';
  const parsed1 = parseSecret(rawHex);
  assert.equal(parsed1.length, 16);
  assert.equal(parsed1[0], 0x00);
  assert.equal(parsed1[15], 0xff);

  const ddHex = 'dd00112233445566778899aabbccddeeff';
  const parsed2 = parseSecret(ddHex);
  assert.deepEqual(parsed1, parsed2);

  const eeHex = 'ee00112233445566778899aabbccddeeff7777772e676f6f676c652e636f6d';
  const parsed3 = parseSecret(eeHex);
  assert.deepEqual(parsed1, parsed3);

  assert.throws(() => parseSecret('tooshort'), /Secret must be 32 hex/);
  assert.throws(() => parseSecret('zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'), /Secret must be 32 hex/);
  assert.throws(() => parseSecret(null), /Secret must be a string or Uint8Array/);
});

test('canonicalizeHostname enforces valid hostnames and rejects IPs', () => {
  assert.equal(canonicalizeHostname('proxy.example.com'), 'proxy.example.com');
  assert.equal(canonicalizeHostname('Proxy.Example.Com:443'), 'proxy.example.com');
  assert.equal(canonicalizeHostname('my-worker.workers.dev.'), 'my-worker.workers.dev');

  assert.throws(() => canonicalizeHostname('127.0.0.1'), /Direct IP addresses are not permitted/);
  assert.throws(() => canonicalizeHostname('149.154.167.51'), /Direct IP addresses are not permitted/);
  assert.throws(() => canonicalizeHostname('[::1]'), /IPv6 addresses are not permitted/);
  assert.throws(() => canonicalizeHostname('localhost'), /Host must contain dot/);
  assert.throws(() => canonicalizeHostname(''), /Invalid host/);
});

test('computeBridgeCapability generates reproducible HMAC-SHA256 base64url capability', async () => {
  const secret = '00112233445566778899aabbccddeeff';
  const hostname = 'telo.workers.dev';

  const cap1 = await computeBridgeCapability(secret, hostname);
  const cap2 = await computeBridgeCapability(`dd${secret}`, hostname);
  assert.equal(cap1, cap2);
  assert.match(cap1, /^[A-Za-z0-9_-]{43}$/); // SHA-256 is 32 bytes -> 43 unpadded b64url chars

  const valid = await verifyBridgeCapability(cap1, secret, hostname);
  assert.equal(valid, true);

  const invalidSecret = await verifyBridgeCapability(cap1, '11112233445566778899aabbccddeeff', hostname);
  assert.equal(invalidSecret, false);

  const invalidHost = await verifyBridgeCapability(cap1, secret, 'other.workers.dev');
  assert.equal(invalidHost, false);
});

test('signSessionToken and verifySessionToken handle valid, expired, and tampered tokens', async () => {
  const secret = '00112233445566778899aabbccddeeff';
  const sessionId = 'session-uuid-1234';
  const now = Math.floor(Date.now() / 1000);

  const token = await signSessionToken(secret, sessionId, now);
  assert.match(token, /^session-uuid-1234\.\d+\.[A-Za-z0-9_-]+$/);

  const verified = await verifySessionToken(secret, token, 3600);
  assert.equal(verified.valid, true);
  assert.equal(verified.sessionId, sessionId);
  assert.equal(verified.timestamp, now);

  // Expired token (> 3600s)
  const expiredNow = now - 5000;
  const expiredToken = await signSessionToken(secret, sessionId, expiredNow);
  const verifyExpired = await verifySessionToken(secret, expiredToken, 3600);
  assert.equal(verifyExpired.valid, false);

  // Tampered signature
  const tamperedToken = `${sessionId}.${now}.tamperedSig123`;
  const verifyTampered = await verifySessionToken(secret, tamperedToken, 3600);
  assert.equal(verifyTampered.valid, false);

  // Malformed token format
  const malformed = 'not.a.valid.format.token';
  assert.equal((await verifySessionToken(secret, malformed)).valid, false);
});

test('encodeFrame produces official 8-byte big-endian header', () => {
  const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
  const streamId = 0x010203; // 66051
  const frame = encodeFrame(FRAME_TYPES.DATA, streamId, payload);

  assert.equal(frame.byteLength, 8 + 4);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);

  // Type: u8
  assert.equal(view.getUint8(0), FRAME_TYPES.DATA);

  // streamId: u24 big-endian
  assert.equal(view.getUint8(1), 0x01);
  assert.equal(view.getUint8(2), 0x02);
  assert.equal(view.getUint8(3), 0x03);

  // payload_length: u32 big-endian
  assert.equal(view.getUint32(4, false), 4);

  // Payload content
  assert.deepEqual(frame.subarray(8), payload);
});

test('decodeFrame decodes valid frames and preserves remainder', () => {
  const payload = new Uint8Array([10, 20, 30]);
  const encoded = encodeFrame(FRAME_TYPES.HELLO, 0, payload);

  const extra = new Uint8Array([99, 88]);
  const streamData = new Uint8Array(encoded.byteLength + extra.byteLength);
  streamData.set(encoded, 0);
  streamData.set(extra, encoded.byteLength);

  const { frame, remainder } = decodeFrame(streamData);
  assert.ok(frame);
  assert.equal(frame.type, FRAME_TYPES.HELLO);
  assert.equal(frame.streamId, 0);
  assert.deepEqual(frame.payload, payload);
  assert.deepEqual(remainder, extra);
});

test('decodeFrames processes multiple frames sequentially across TCP/WS chunks', () => {
  const f1 = encodeFrame(FRAME_TYPES.HELLO, 0, new Uint8Array(0));
  const f2 = encodeFrame(FRAME_TYPES.OPEN, 1, new Uint8Array([2]));
  const f3 = encodeFrame(FRAME_TYPES.DATA, 1, new Uint8Array([1, 2, 3, 4]));

  const combined = new Uint8Array(f1.byteLength + f2.byteLength + f3.byteLength + 3);
  combined.set(f1, 0);
  combined.set(f2, f1.byteLength);
  combined.set(f3, f1.byteLength + f2.byteLength);
  combined.set([0xaa, 0xbb, 0xcc], f1.byteLength + f2.byteLength + f3.byteLength); // partial trailing frame

  const { frames, remainder } = decodeFrames(combined);
  assert.equal(frames.length, 3);
  assert.equal(frames[0].type, FRAME_TYPES.HELLO);
  assert.equal(frames[1].type, FRAME_TYPES.OPEN);
  assert.equal(frames[1].streamId, 1);
  assert.equal(frames[2].type, FRAME_TYPES.DATA);
  assert.deepEqual(remainder, new Uint8Array([0xaa, 0xbb, 0xcc]));
});

test('Protocol limits enforce 64KiB max DATA chunk and 2MiB carrier hard max', () => {
  // DATA frame exceeding 64KiB must throw ProtocolError
  const oversizedData = new Uint8Array(MAX_DATA_CHUNK + 1);
  assert.throws(
    () => encodeFrame(FRAME_TYPES.DATA, 1, oversizedData),
    (err) => err instanceof ProtocolError && err.code === 1002
  );

  // Exact 64KiB DATA chunk must succeed
  const maxValidData = new Uint8Array(MAX_DATA_CHUNK);
  assert.doesNotThrow(() => encodeFrame(FRAME_TYPES.DATA, 1, maxValidData));
});

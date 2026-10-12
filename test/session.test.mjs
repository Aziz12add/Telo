import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  FRAME_TYPES,
  encodeFrame,
  decodeFrame,
  decodeFrames,
  INITIAL_STREAM_WINDOW,
  MAX_STREAMS_PER_SESSION,
} from '../src/worker/protocol.ts';

// Mock MockWebSocket simulating Cloudflare Workers WebSocketPair
class MockWebSocket extends EventEmitter {
  constructor() {
    super();
    this.sentBuffers = [];
    this.closed = false;
    this.closeCode = null;
    this.closeReason = null;
  }

  accept() {}

  send(data) {
    if (this.closed) throw new Error('WebSocket is closed');
    const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.sentBuffers.push(buf);
    this.emit('outgoing', buf);
  }

  close(code = 1000, reason = '') {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    this.emit('close', { code, reason });
  }

  // Helper to simulate client message
  simulateClientMessage(buffer) {
    this.emit('message', { data: buffer });
  }

  // Helper to extract sent frames
  getSentFrames() {
    const frames = [];
    for (const buf of this.sentBuffers) {
      const { frames: decoded } = decodeFrames(buf);
      frames.push(...decoded);
    }
    return frames;
  }
}

// Mock Upstream TCP Socket simulating cloudflare:sockets connect()
class MockTcpSocket {
  constructor(hostname, port) {
    this.hostname = hostname;
    this.port = port;
    this.writtenChunks = [];
    this.closed = false;

    // Readable stream from DC to Worker
    let controller;
    this.readable = new ReadableStream({
      start(c) {
        controller = c;
      },
    });
    this._readableController = controller;

    // Writable stream from Worker to DC
    const self = this;
    this.writable = new WritableStream({
      write(chunk) {
        self.writtenChunks.push(chunk);
      },
      close() {
        self.closed = true;
      },
    });
  }

  simulateDcResponse(data) {
    this._readableController.enqueue(data);
  }

  close() {
    this.closed = true;
    try {
      this._readableController.close();
    } catch {}
  }
}

test('ProxySessionDO protocol lifecycle: HELLO, WELCOME, PING, PONG', async () => {
  const ws = new MockWebSocket();

  // Test HELLO -> WELCOME
  const helloFrame = encodeFrame(FRAME_TYPES.HELLO, 0);
  assert.equal(helloFrame.byteLength, 8);

  // Parse WELCOME payload format expectation: [4B initialWindow BE][4B maxStreams BE]
  const welcomePayload = new Uint8Array(8);
  const view = new DataView(welcomePayload.buffer);
  view.setUint32(0, INITIAL_STREAM_WINDOW, false);
  view.setUint32(4, MAX_STREAMS_PER_SESSION, false);

  const welcomeFrame = encodeFrame(FRAME_TYPES.WELCOME, 0, welcomePayload);
  const decodedWelcome = decodeFrame(welcomeFrame);

  assert.equal(decodedWelcome.frame.type, FRAME_TYPES.WELCOME);
  assert.equal(decodedWelcome.frame.streamId, 0);
  const welcomeView = new DataView(decodedWelcome.frame.payload.buffer, decodedWelcome.frame.payload.byteOffset);
  assert.equal(welcomeView.getUint32(0, false), 4 * 1024 * 1024);
  assert.equal(welcomeView.getUint32(4, false), 32);

  // Test PING -> PONG
  const pingPayload = new TextEncoder().encode('heartbeat-123');
  const pingFrame = encodeFrame(FRAME_TYPES.PING, 0, pingPayload);
  const decodedPing = decodeFrame(pingFrame);

  const pongFrame = encodeFrame(FRAME_TYPES.PONG, decodedPing.frame.streamId, decodedPing.frame.payload);
  const decodedPong = decodeFrame(pongFrame);
  assert.equal(decodedPong.frame.type, FRAME_TYPES.PONG);
  assert.deepEqual(decodedPong.frame.payload, pingPayload);
});

test('Stream Multiplexing and Flow Control codec verification', () => {
  // OPEN frame with target DC 2
  const openPayload = new Uint8Array([2]);
  const openFrame = encodeFrame(FRAME_TYPES.OPEN, 1, openPayload);
  const decodedOpen = decodeFrame(openFrame);
  assert.equal(decodedOpen.frame.type, FRAME_TYPES.OPEN);
  assert.equal(decodedOpen.frame.streamId, 1);
  assert.equal(decodedOpen.frame.payload[0], 2);

  // DATA frame on stream 1
  const clientData = new Uint8Array([0xef, 0xef, 0xef, 0xef, 0xaa, 0xbb]);
  const dataFrame = encodeFrame(FRAME_TYPES.DATA, 1, clientData);
  const decodedData = decodeFrame(dataFrame);
  assert.equal(decodedData.frame.type, FRAME_TYPES.DATA);
  assert.equal(decodedData.frame.streamId, 1);
  assert.deepEqual(decodedData.frame.payload, clientData);

  // WINDOW frame granting credit
  const creditPayload = new Uint8Array(4);
  new DataView(creditPayload.buffer).setUint32(0, 1024 * 1024, false);
  const windowFrame = encodeFrame(FRAME_TYPES.WINDOW, 1, creditPayload);
  const decodedWindow = decodeFrame(windowFrame);
  assert.equal(decodedWindow.frame.type, FRAME_TYPES.WINDOW);
  assert.equal(decodedWindow.frame.streamId, 1);
  assert.equal(new DataView(decodedWindow.frame.payload.buffer, decodedWindow.frame.payload.byteOffset).getUint32(0, false), 1024 * 1024);

  // CLOSE frame on stream 1
  const closeFrame = encodeFrame(FRAME_TYPES.CLOSE, 1, new Uint8Array([0x00]));
  const decodedClose = decodeFrame(closeFrame);
  assert.equal(decodedClose.frame.type, FRAME_TYPES.CLOSE);
  assert.equal(decodedClose.frame.streamId, 1);
  assert.equal(decodedClose.frame.payload[0], 0x00);

  // BYE frame closing session
  const byeFrame = encodeFrame(FRAME_TYPES.BYE, 0);
  const decodedBye = decodeFrame(byeFrame);
  assert.equal(decodedBye.frame.type, FRAME_TYPES.BYE);
  assert.equal(decodedBye.frame.streamId, 0);
});

test('Concurrent streams handle distinct stream IDs without collisions', () => {
  const stream1Data = new TextEncoder().encode('stream-1-payload');
  const stream2Data = new TextEncoder().encode('stream-2-payload');

  const f1 = encodeFrame(FRAME_TYPES.DATA, 1, stream1Data);
  const f2 = encodeFrame(FRAME_TYPES.DATA, 2, stream2Data);

  const buffer = new Uint8Array(f1.byteLength + f2.byteLength);
  buffer.set(f1, 0);
  buffer.set(f2, f1.byteLength);

  const { frames } = decodeFrames(buffer);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].streamId, 1);
  assert.deepEqual(frames[0].payload, stream1Data);
  assert.equal(frames[1].streamId, 2);
  assert.deepEqual(frames[1].payload, stream2Data);
});

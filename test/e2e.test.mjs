import test from 'node:test';
import assert from 'node:assert/strict';

import worker, { ProxySessionDO } from '../src/worker/index.ts';
import {
  computeBridgeCapability,
  signSessionToken,
  encodeFrame,
  decodeFrame,
  decodeFrames,
  FRAME_TYPES,
} from '../src/worker/protocol.ts';

// Mock DurableObjectNamespace simulating Cloudflare Workers SESSIONS binding
class MockDurableObjectNamespace {
  constructor() {
    this.instances = new Map();
  }

  idFromName(name) {
    return { name, toString: () => `id-from-name:${name}` };
  }

  newUniqueId() {
    const id = `unique-${crypto.randomUUID()}`;
    return { name: id, toString: () => id };
  }

  get(idObj) {
    const key = idObj.toString();
    if (!this.instances.has(key)) {
      const mockState = {
        id: idObj,
        storage: new Map(),
      };
      this.instances.set(key, {
        id: idObj,
        fetch: async (request) => {
          // Verify internal security header
          const auth = request.headers.get('X-Internal-Auth');
          if (auth !== 'trusted-worker') {
            return new Response('Forbidden', { status: 403 });
          }
          // Return simulated WebSocket upgrade response
          const requestedProto = request.headers.get('Sec-WebSocket-Protocol');
          const headers = new Headers();
          if (requestedProto) {
            const matched = requestedProto.split(',').map((p) => p.trim()).find((p) => p.startsWith('tproxy-v1'));
            if (matched) headers.set('Sec-WebSocket-Protocol', matched);
          }
          // In Node.js environment, undici throws on status 101 in constructor, so we provide status: 101 via custom or 200 with headers
          return {
            status: 101,
            headers,
          };
        },
      });
    }
    return this.instances.get(key);
  }
}

test('E2E: Healthz and Readyz endpoints', async () => {
  const env = {
    PROXY_SECRET: '00112233445566778899aabbccddeeff',
    SESSIONS: new MockDurableObjectNamespace(),
  };

  // /healthz
  const healthRes = await worker.fetch(new Request('https://proxy.example.com/healthz'), env, {});
  assert.equal(healthRes.status, 200);
  const healthJson = await healthRes.json();
  assert.equal(healthJson.ok, true);
  assert.equal(healthJson.service, 'telo-webproxy');

  // /readyz
  const readyRes = await worker.fetch(new Request('https://proxy.example.com/readyz'), env, {});
  assert.equal(readyRes.status, 200);
  const readyText = await readyRes.text();
  assert.equal(readyText, 'ready');
});

test('E2E: Decoy defense on unauthenticated and probe requests', async () => {
  const env = {
    PROXY_SECRET: '00112233445566778899aabbccddeeff',
    SESSIONS: new MockDurableObjectNamespace(),
  };

  // Unknown route
  const r1 = await worker.fetch(new Request('https://proxy.example.com/random-path'), env, {});
  assert.equal(r1.status, 404);
  assert.equal(await r1.text(), '404 Not Found');

  // Root without valid bridge
  const r2 = await worker.fetch(new Request('https://proxy.example.com/'), env, {});
  assert.equal(r2.status, 404);

  // Root with invalid bridge
  const r3 = await worker.fetch(new Request('https://proxy.example.com/?bridge=invalidCapabilityHash'), env, {});
  assert.equal(r3.status, 404);
});

test('E2E: Bridge landing page with authentic Telegram connection links', async () => {
  const secret = '00112233445566778899aabbccddeeff';
  const hostname = 'proxy.example.com';
  const bridge = await computeBridgeCapability(secret, hostname);

  const env = {
    PROXY_SECRET: secret,
    SESSIONS: new MockDurableObjectNamespace(),
  };

  const res = await worker.fetch(new Request(`https://${hostname}/?bridge=${bridge}`), env, {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'text/html; charset=utf-8');

  const html = await res.text();
  assert.ok(html.includes(`https://t.me/webproxy?server=${encodeURIComponent(hostname)}&secret=${encodeURIComponent(secret)}`));
  assert.ok(html.includes(`tg://webproxy?server=${encodeURIComponent(hostname)}&secret=${encodeURIComponent(secret)}`));
  assert.ok(html.includes(bridge));
});

test('E2E: Session bootstrap endpoint generates valid signed session token', async () => {
  const secret = '00112233445566778899aabbccddeeff';
  const hostname = 'proxy.example.com';
  const bridge = await computeBridgeCapability(secret, hostname);

  const env = {
    PROXY_SECRET: secret,
    SESSIONS: new MockDurableObjectNamespace(),
  };

  const res = await worker.fetch(new Request(`https://${hostname}/session/bootstrap?bridge=${bridge}`), env, {});
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(body.token);
  assert.ok(body.sessionId);
  assert.equal(body.wsUrl, `wss://${hostname}/api/v1/ws`);
});

test('E2E: WebSocket upgrade authentication and isolated DO routing', async () => {
  const secret = '00112233445566778899aabbccddeeff';
  const hostname = 'proxy.example.com';
  const bridge = await computeBridgeCapability(secret, hostname);

  const mockSessions = new MockDurableObjectNamespace();
  const env = {
    PROXY_SECRET: secret,
    SESSIONS: mockSessions,
  };

  // Case 1: Connect with Subprotocol tproxy-v1.<bridge>
  const wsReq1 = new Request(`https://${hostname}/api/v1/ws`, {
    headers: {
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Protocol': `tproxy-v1.${bridge}`,
    },
  });

  const wsRes1 = await worker.fetch(wsReq1, env, {});
  assert.equal(wsRes1.status, 101);
  assert.equal(wsRes1.headers.get('Sec-WebSocket-Protocol'), `tproxy-v1.${bridge}`);

  // Case 2: Connect with Session Token in query param ?token=
  const sessionIdA = 'session-user-alice';
  const tokenA = await signSessionToken(secret, sessionIdA, Math.floor(Date.now() / 1000));
  const wsReq2 = new Request(`https://${hostname}/api/v1/ws?token=${tokenA}`, {
    headers: {
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Protocol': `tproxy-v1.${tokenA}`,
    },
  });

  const wsRes2 = await worker.fetch(wsReq2, env, {});
  assert.equal(wsRes2.status, 101);

  // Case 3: Connect with another Session Token ?token= (Bob)
  const sessionIdB = 'session-user-bob';
  const tokenB = await signSessionToken(secret, sessionIdB, Math.floor(Date.now() / 1000));
  const wsReq3 = new Request(`https://${hostname}/api/v1/ws?token=${tokenB}`, {
    headers: {
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Protocol': `tproxy-v1.${tokenB}`,
    },
  });

  const wsRes3 = await worker.fetch(wsReq3, env, {});
  assert.equal(wsRes3.status, 101);

  // Verify DO instances are isolated (not a shared singleton!)
  assert.ok(mockSessions.instances.has(`id-from-name:${sessionIdA}`));
  assert.ok(mockSessions.instances.has(`id-from-name:${sessionIdB}`));
  assert.notEqual(
    mockSessions.instances.get(`id-from-name:${sessionIdA}`),
    mockSessions.instances.get(`id-from-name:${sessionIdB}`)
  );
});

test('E2E: Telegram Client Protocol frame exchange simulation', () => {
  // Simulate complete client-server frame flow:
  // 1. Client sends HELLO
  const hello = encodeFrame(FRAME_TYPES.HELLO, 0);
  assert.equal(hello.byteLength, 8);

  // 2. Server replies WELCOME [4B initialWindow BE][4B maxStreams BE]
  const welcomePayload = new Uint8Array(8);
  const wView = new DataView(welcomePayload.buffer);
  wView.setUint32(0, 4 * 1024 * 1024, false);
  wView.setUint32(4, 32, false);
  const welcome = encodeFrame(FRAME_TYPES.WELCOME, 0, welcomePayload);

  const decWelcome = decodeFrame(welcome);
  assert.equal(decWelcome.frame.type, FRAME_TYPES.WELCOME);
  assert.equal(decWelcome.frame.streamId, 0);

  // 3. Client sends OPEN for DC 2 (streamId: 1)
  const open = encodeFrame(FRAME_TYPES.OPEN, 1, new Uint8Array([2]));
  const decOpen = decodeFrame(open);
  assert.equal(decOpen.frame.type, FRAME_TYPES.OPEN);
  assert.equal(decOpen.frame.streamId, 1);
  assert.equal(decOpen.frame.payload[0], 2);

  // 4. Client sends opaque MTProto DATA (streamId: 1)
  const mtprotoOpaquePayload = new Uint8Array(128).fill(0x7a);
  const data = encodeFrame(FRAME_TYPES.DATA, 1, mtprotoOpaquePayload);
  const decData = decodeFrame(data);
  assert.equal(decData.frame.type, FRAME_TYPES.DATA);
  assert.equal(decData.frame.streamId, 1);
  assert.deepEqual(decData.frame.payload, mtprotoOpaquePayload);

  // 5. Server relays DC response DATA (streamId: 1)
  const dcResponseOpaque = new Uint8Array(256).fill(0x3b);
  const dcData = encodeFrame(FRAME_TYPES.DATA, 1, dcResponseOpaque);
  const decDcData = decodeFrame(dcData);
  assert.equal(decDcData.frame.type, FRAME_TYPES.DATA);
  assert.equal(decDcData.frame.streamId, 1);
  assert.deepEqual(decDcData.frame.payload, dcResponseOpaque);

  // 6. Client acknowledges with WINDOW (streamId: 1)
  const windowPayload = new Uint8Array(4);
  new DataView(windowPayload.buffer).setUint32(0, 65536, false);
  const window = encodeFrame(FRAME_TYPES.WINDOW, 1, windowPayload);
  const decWindow = decodeFrame(window);
  assert.equal(decWindow.frame.type, FRAME_TYPES.WINDOW);
  assert.equal(decWindow.frame.streamId, 1);

  // 7. Client closes stream with CLOSE (streamId: 1)
  const close = encodeFrame(FRAME_TYPES.CLOSE, 1, new Uint8Array([0x00]));
  const decClose = decodeFrame(close);
  assert.equal(decClose.frame.type, FRAME_TYPES.CLOSE);
  assert.equal(decClose.frame.streamId, 1);

  // 8. Session teardown with BYE (streamId: 0)
  const bye = encodeFrame(FRAME_TYPES.BYE, 0);
  const decBye = decodeFrame(bye);
  assert.equal(decBye.frame.type, FRAME_TYPES.BYE);
  assert.equal(decBye.frame.streamId, 0);
});

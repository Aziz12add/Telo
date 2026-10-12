// src/worker/protocol.ts
var FRAME_TYPES = Object.freeze({
  OPEN: 1,
  DATA: 2,
  CLOSE: 3,
  WINDOW: 4,
  PING: 5,
  PONG: 6,
  HELLO: 16,
  WELCOME: 17,
  BYE: 31
});
var MAX_DATA_CHUNK = 64 * 1024;
var CARRIER_HARD_MAX = 2 * 1024 * 1024;
var INITIAL_STREAM_WINDOW = 4 * 1024 * 1024;
var MAX_STREAMS_PER_SESSION = 32;
var ProtocolError = class extends Error {
  constructor(message, code = 1002) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
};
function constantTimeCompare(a, b) {
  if (typeof a === "string" && typeof b === "string") {
    if (a.length !== b.length) return false;
    let diff2 = 0;
    for (let i = 0; i < a.length; i++) {
      diff2 |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff2 === 0;
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
function parseSecret(secret) {
  if (secret instanceof Uint8Array) {
    if (secret.length === 16) return secret;
    throw new Error("Secret byte array must be exactly 16 bytes");
  }
  if (typeof secret !== "string") {
    throw new TypeError("Secret must be a string or Uint8Array");
  }
  let s = secret.trim().toLowerCase();
  if (s.startsWith("dd")) {
    s = s.slice(2);
  } else if (s.startsWith("ee")) {
    s = s.slice(2, 34);
  }
  if (s.length !== 32 || !/^[0-9a-f]{32}$/.test(s)) {
    throw new Error("Secret must be 32 hex characters (or prefixed with dd/ee)");
  }
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
function toBase64UrlNoPad(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function canonicalizeHostname(rawHost) {
  if (!rawHost || typeof rawHost !== "string") {
    throw new Error("Invalid host");
  }
  const raw = rawHost.trim().toLowerCase();
  if (raw.startsWith("[") || (raw.match(/:/g) || []).length > 1) {
    throw new Error("IPv6 addresses are not permitted");
  }
  const clean = raw.split(":")[0].trim().replace(/\.+$/, "");
  if (!clean || clean.length < 3 || !clean.includes(".")) {
    throw new Error("Host must contain dot and be at least 3 characters");
  }
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(clean)) {
    throw new Error("Direct IP addresses are not permitted");
  }
  try {
    const url = new URL("https://" + clean);
    return url.hostname;
  } catch {
    throw new Error("Invalid URL hostname");
  }
}
async function computeBridgeCapability(secret, hostname) {
  const canonicalHost = canonicalizeHostname(hostname);
  const secretBytes = parseSecret(secret);
  const context = new TextEncoder().encode(`tdesktop-web-proxy-bridge-v1
${canonicalHost}`);
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, context);
  return toBase64UrlNoPad(signature);
}
async function verifyBridgeCapability(providedBridge, secret, hostname) {
  try {
    if (!providedBridge || typeof providedBridge !== "string") return false;
    const expected = await computeBridgeCapability(secret, hostname);
    return constantTimeCompare(providedBridge.trim(), expected);
  } catch {
    return false;
  }
}
async function signSessionToken(secret, sessionId, timestamp) {
  const secretBytes = parseSecret(secret);
  const data = new TextEncoder().encode(`session-v1
${sessionId}
${timestamp}`);
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, data);
  const sigB64 = toBase64UrlNoPad(sig);
  return `${sessionId}.${timestamp}.${sigB64}`;
}
async function verifySessionToken(secret, token, maxAgeSeconds = 3600) {
  if (typeof token !== "string") {
    return { valid: false };
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    return { valid: false };
  }
  const [sessionId, tsStr, signature] = parts;
  const timestamp = parseInt(tsStr, 10);
  if (!Number.isFinite(timestamp)) {
    return { valid: false };
  }
  const now = Math.floor(Date.now() / 1e3);
  if (Math.abs(now - timestamp) > maxAgeSeconds) {
    return { valid: false };
  }
  try {
    const expectedToken = await signSessionToken(secret, sessionId, timestamp);
    const expectedSig = expectedToken.split(".")[2];
    if (!constantTimeCompare(signature, expectedSig)) {
      return { valid: false };
    }
    return { valid: true, sessionId, timestamp };
  } catch {
    return { valid: false };
  }
}
function encodeFrame(type, streamId = 0, payload = new Uint8Array(0)) {
  const payloadBytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload || 0);
  const payloadLen = payloadBytes.byteLength;
  if (type === FRAME_TYPES.DATA && payloadLen > MAX_DATA_CHUNK) {
    throw new ProtocolError(`DATA frame payload ${payloadLen} exceeds 64KiB`, 1002);
  }
  if (payloadLen > CARRIER_HARD_MAX) {
    throw new ProtocolError(`Frame payload ${payloadLen} exceeds carrier limit 2MiB`, 1002);
  }
  const buffer = new Uint8Array(8 + payloadLen);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  view.setUint8(0, type & 255);
  view.setUint8(1, streamId >>> 16 & 255);
  view.setUint8(2, streamId >>> 8 & 255);
  view.setUint8(3, streamId & 255);
  view.setUint32(4, payloadLen, false);
  if (payloadLen > 0) {
    buffer.set(payloadBytes, 8);
  }
  return buffer;
}
function decodeFrame(buffer) {
  if (!(buffer instanceof Uint8Array)) {
    throw new TypeError("Buffer must be an instance of Uint8Array");
  }
  if (buffer.byteLength < 8) {
    return { frame: null, remainder: buffer };
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const type = view.getUint8(0);
  const streamId = (view.getUint8(1) << 16 | view.getUint8(2) << 8 | view.getUint8(3)) >>> 0;
  const payloadLen = view.getUint32(4, false);
  if (payloadLen > CARRIER_HARD_MAX) {
    throw new ProtocolError(`Payload length ${payloadLen} exceeds carrier limit 2MiB`, 1002);
  }
  if (buffer.byteLength < 8 + payloadLen) {
    return { frame: null, remainder: buffer };
  }
  if (type === FRAME_TYPES.DATA && payloadLen > MAX_DATA_CHUNK) {
    throw new ProtocolError(`DATA frame payload ${payloadLen} exceeds 64KiB`, 1002);
  }
  const payload = buffer.subarray(8, 8 + payloadLen);
  const remainder = buffer.subarray(8 + payloadLen);
  return {
    frame: { type, streamId, payload },
    remainder
  };
}
function decodeFrames(buffer) {
  const frames = [];
  let current = buffer;
  while (current.byteLength >= 8) {
    const { frame, remainder } = decodeFrame(current);
    if (!frame) {
      break;
    }
    frames.push(frame);
    current = remainder;
  }
  return { frames, remainder: current };
}

// src/worker/session.ts
async function dialTelegramSocket(options) {
  try {
    const sockets = await import("cloudflare:sockets");
    return sockets.connect(options);
  } catch {
    throw new Error("cloudflare:sockets is only available in Cloudflare Workers runtime");
  }
}
var TELEGRAM_DCS = Object.freeze({
  1: { ip: "149.154.175.50", port: 443 },
  2: { ip: "149.154.167.51", port: 443 },
  3: { ip: "149.154.175.100", port: 443 },
  4: { ip: "149.154.167.91", port: 443 },
  5: { ip: "91.108.56.130", port: 443 }
});
var DEFAULT_DC = TELEGRAM_DCS[2];
var IDLE_TIMEOUT_MS = 3e5;
var StreamContext = class {
  constructor(streamId, dcId, abortController) {
    this.socket = null;
    this.writer = null;
    this.reader = null;
    this.closed = false;
    this.streamId = streamId;
    this.dcId = dcId;
    this.abortController = abortController;
    this.inboundWindow = INITIAL_STREAM_WINDOW;
    this.outboundWindow = INITIAL_STREAM_WINDOW;
  }
};
var ProxySessionDO = class {
  constructor(state, env) {
    this.ws = null;
    this.streams = /* @__PURE__ */ new Map();
    this.tombstones = /* @__PURE__ */ new Set();
    this.rxBuffer = new Uint8Array(0);
    this.idleTimer = null;
    this.state = state;
    this.env = env;
  }
  touchIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(() => {
      this.closeCarrierProtocolViolation("Session idle timeout", 1e3);
    }, IDLE_TIMEOUT_MS);
  }
  async fetch(request) {
    const internalAuth = request.headers.get("X-Internal-Auth");
    if (!internalAuth || !constantTimeCompare(internalAuth, "trusted-worker")) {
      return new Response("Unauthorized internal call", { status: 403 });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    const pair = new WebSocketPair();
    const clientSocket = pair[0];
    const serverSocket = pair[1];
    serverSocket.accept();
    this.ws = serverSocket;
    this.touchIdleTimer();
    this.bindCarrierSocket(serverSocket);
    const headers = new Headers();
    const requestedProtocol = request.headers.get("Sec-WebSocket-Protocol");
    if (requestedProtocol) {
      const parts = requestedProtocol.split(",").map((p) => p.trim());
      const matched = parts.find((p) => p.startsWith("tproxy-v1"));
      if (matched) {
        headers.set("Sec-WebSocket-Protocol", matched);
      }
    }
    return new Response(null, {
      status: 101,
      // @ts-ignore webSocket response in Cloudflare Workers
      webSocket: clientSocket,
      headers
    });
  }
  bindCarrierSocket(ws) {
    ws.addEventListener("message", async (event) => {
      this.touchIdleTimer();
      try {
        let chunk;
        if (typeof event.data === "string") {
          chunk = new TextEncoder().encode(event.data);
        } else if (event.data instanceof ArrayBuffer) {
          chunk = new Uint8Array(event.data);
        } else {
          chunk = new Uint8Array(await event.data.arrayBuffer());
        }
        const next = new Uint8Array(this.rxBuffer.byteLength + chunk.byteLength);
        next.set(this.rxBuffer, 0);
        next.set(chunk, this.rxBuffer.byteLength);
        this.rxBuffer = next;
        const { frames, remainder } = decodeFrames(this.rxBuffer);
        this.rxBuffer = remainder;
        for (const frame of frames) {
          await this.handleFrame(frame);
        }
      } catch (err) {
        if (err instanceof ProtocolError) {
          this.closeCarrierProtocolViolation(err.message, err.code || 1002);
        } else {
          this.closeCarrierProtocolViolation("Frame decode violation", 1002);
        }
      }
    });
    ws.addEventListener("close", () => {
      this.closeAllStreams(0);
      this.ws = null;
    });
    ws.addEventListener("error", () => {
      this.closeAllStreams(1);
      this.ws = null;
    });
  }
  async handleFrame(frame) {
    const { type, streamId, payload } = frame;
    switch (type) {
      case FRAME_TYPES.HELLO: {
        const welcome = new Uint8Array(8);
        const view = new DataView(welcome.buffer);
        view.setUint32(0, INITIAL_STREAM_WINDOW, false);
        view.setUint32(4, MAX_STREAMS_PER_SESSION, false);
        this.sendFrame(FRAME_TYPES.WELCOME, 0, welcome);
        break;
      }
      case FRAME_TYPES.OPEN: {
        if (streamId === 0) {
          this.sendStreamClose(0, 1);
          return;
        }
        let targetDcId = 2;
        let explicitTarget = null;
        if (payload.byteLength === 1) {
          targetDcId = payload[0];
        } else if (payload.byteLength === 2) {
          const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
          targetDcId = Math.abs(view.getInt16(0, false));
        } else if (payload.byteLength >= 6) {
          const ip = `${payload[0]}.${payload[1]}.${payload[2]}.${payload[3]}`;
          const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
          const port = view.getUint16(4, false);
          explicitTarget = { ip, port: port || 443 };
        }
        if (this.tombstones.has(streamId) || this.streams.has(streamId)) {
          return;
        }
        if (this.streams.size >= MAX_STREAMS_PER_SESSION) {
          this.sendStreamClose(streamId, 3);
          return;
        }
        await this.openDcStream(streamId, targetDcId, explicitTarget);
        break;
      }
      case FRAME_TYPES.DATA: {
        const stream = this.streams.get(streamId);
        if (!stream || stream.closed) {
          return;
        }
        await this.forwardDataUpstream(stream, payload);
        break;
      }
      case FRAME_TYPES.WINDOW: {
        const stream = this.streams.get(streamId);
        if (stream && !stream.closed && payload.byteLength >= 4) {
          const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
          const credit = view.getUint32(0, false);
          stream.outboundWindow = Math.min(
            stream.outboundWindow + credit,
            INITIAL_STREAM_WINDOW * 2
          );
        }
        break;
      }
      case FRAME_TYPES.PING: {
        this.sendFrame(FRAME_TYPES.PONG, streamId, payload);
        break;
      }
      case FRAME_TYPES.CLOSE: {
        const code = payload.byteLength >= 1 ? payload[0] : 0;
        this.closeStream(streamId, code);
        break;
      }
      case FRAME_TYPES.BYE: {
        this.closeAllStreams(0);
        if (this.ws) {
          try {
            this.ws.close(1e3, "Client requested bye");
          } catch {
          }
          this.ws = null;
        }
        break;
      }
    }
  }
  async openDcStream(streamId, dcId, explicitTarget = null) {
    const abortController = new AbortController();
    const stream = new StreamContext(streamId, dcId, abortController);
    this.streams.set(streamId, stream);
    const targetDc = explicitTarget || TELEGRAM_DCS[dcId] || DEFAULT_DC;
    try {
      const dialTimeout = setTimeout(() => {
        abortController.abort();
      }, 1e4);
      const socket = await dialTelegramSocket({
        hostname: targetDc.ip,
        port: targetDc.port
      });
      clearTimeout(dialTimeout);
      if (stream.closed || abortController.signal.aborted) {
        try {
          socket.close();
        } catch {
        }
        return;
      }
      stream.socket = socket;
      stream.writer = socket.writable.getWriter();
      stream.reader = socket.readable.getReader();
      this.pumpUpstreamToCarrier(stream);
    } catch {
      this.closeStream(streamId, 1);
    }
  }
  async forwardDataUpstream(stream, data) {
    if (stream.closed || !stream.writer || data.byteLength === 0) return;
    try {
      await stream.writer.write(data);
      stream.inboundWindow -= data.byteLength;
      if (stream.inboundWindow <= INITIAL_STREAM_WINDOW / 2) {
        const credit = INITIAL_STREAM_WINDOW - stream.inboundWindow;
        stream.inboundWindow += credit;
        this.sendStreamWindow(stream.streamId, credit);
      }
    } catch {
      this.closeStream(stream.streamId, 2);
    }
  }
  async pumpUpstreamToCarrier(stream) {
    try {
      while (!stream.closed && stream.reader) {
        const { value, done } = await stream.reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          let offset = 0;
          while (offset < value.byteLength && !stream.closed) {
            const chunkSize = Math.min(MAX_DATA_CHUNK, value.byteLength - offset);
            const chunk = value.subarray(offset, offset + chunkSize);
            this.sendFrame(FRAME_TYPES.DATA, stream.streamId, chunk);
            offset += chunkSize;
            stream.outboundWindow -= chunkSize;
            if (stream.outboundWindow <= 0) {
              await this.waitForStreamCredit(stream);
            }
          }
        }
      }
    } catch {
    } finally {
      this.closeStream(stream.streamId, 0);
    }
  }
  async waitForStreamCredit(stream) {
    let waited = 0;
    while (stream.outboundWindow <= 0 && !stream.closed && waited < 100) {
      await new Promise((r) => setTimeout(r, 20));
      waited++;
    }
  }
  sendStreamWindow(streamId, credit) {
    const payload = new Uint8Array(4);
    const view = new DataView(payload.buffer);
    view.setUint32(0, credit, false);
    this.sendFrame(FRAME_TYPES.WINDOW, streamId, payload);
  }
  sendStreamClose(streamId, code = 0) {
    const payload = new Uint8Array([code & 255]);
    this.sendFrame(FRAME_TYPES.CLOSE, streamId, payload);
  }
  sendFrame(type, streamId = 0, payload = new Uint8Array(0)) {
    if (!this.ws) return;
    try {
      const buffer = encodeFrame(type, streamId, payload);
      this.ws.send(buffer);
    } catch {
      this.closeCarrierProtocolViolation("Carrier write failure", 1002);
    }
  }
  closeStream(streamId, code = 0) {
    const stream = this.streams.get(streamId);
    if (!stream) return;
    stream.closed = true;
    stream.abortController.abort();
    this.streams.delete(streamId);
    this.tombstones.add(streamId);
    try {
      if (stream.writer) stream.writer.close();
      if (stream.reader) stream.reader.cancel();
      if (stream.socket) stream.socket.close();
    } catch {
    }
    this.sendStreamClose(streamId, code);
  }
  closeAllStreams(code = 0) {
    for (const streamId of Array.from(this.streams.keys())) {
      this.closeStream(streamId, code);
    }
  }
  closeCarrierProtocolViolation(reason, code = 1002) {
    this.closeAllStreams(1);
    if (this.ws) {
      try {
        this.ws.close(code, reason);
      } catch {
      }
      this.ws = null;
    }
  }
};

// src/worker/index.ts
function renderDecoyPage() {
  return new Response("404 Not Found", {
    status: 404,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "X-Content-Type-Options": "nosniff"
    }
  });
}
function renderBridgePage(host, bridge, secret) {
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const tmeLink = `https://t.me/webproxy?server=${encodeURIComponent(host)}&secret=${encodeURIComponent(secret)}`;
  const tgLink = `tg://webproxy?server=${encodeURIComponent(host)}&secret=${encodeURIComponent(secret)}`;
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Telegram Official WEB Proxy v1</title>
  <meta http-equiv="Content-Security-Policy" content="default-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline';">
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      background: #0b0f19;
      color: #f1f5f9;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 16px;
      box-sizing: border-box;
    }
    .container {
      background: #111827;
      border: 1px solid #1f2937;
      border-radius: 16px;
      padding: 32px;
      max-width: 460px;
      width: 100%;
      box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5);
      text-align: center;
    }
    .logo {
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: #2563eb;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 16px;
      color: #ffffff;
      font-size: 24px;
    }
    h1 {
      font-size: 1.35rem;
      font-weight: 700;
      margin: 0 0 8px;
    }
    p {
      color: #94a3b8;
      font-size: 0.875rem;
      margin: 0 0 24px;
      line-height: 1.5;
    }
    .btn {
      display: block;
      width: 100%;
      padding: 12px 0;
      border-radius: 8px;
      font-size: 0.95rem;
      font-weight: 600;
      text-decoration: none;
      cursor: pointer;
      margin-bottom: 12px;
      box-sizing: border-box;
      transition: all 0.15s ease;
    }
    .btn-primary {
      background: #2563eb;
      color: #ffffff;
      border: none;
    }
    .btn-primary:hover {
      background: #1d4ed8;
    }
    .btn-secondary {
      background: #1f2937;
      color: #cbd5e1;
      border: 1px solid #374151;
    }
    .btn-secondary:hover {
      background: #374151;
    }
    .info-box {
      background: #030712;
      border: 1px solid #1f2937;
      border-radius: 8px;
      padding: 12px;
      font-family: monospace;
      font-size: 0.75rem;
      color: #38bdf8;
      text-align: left;
      overflow-x: auto;
      margin-top: 16px;
      word-break: break-all;
    }
    .status {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      font-size: 0.75rem;
      color: #10b981;
      margin-bottom: 20px;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #10b981;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">&#9992;</div>
    <h1>Telegram WEB Proxy</h1>
    <div class="status"><span class="dot"></span> Worker Ready &bull; Protocol v1</div>
    <p>Official Telegram WEB Proxy bridge capability verified. Click below to add the proxy to your Telegram client.</p>
    <a href="${tmeLink}" class="btn btn-primary" target="_blank" rel="noopener">Connect via Telegram (t.me)</a>
    <a href="${tgLink}" class="btn btn-secondary">Open Directly (tg://)</a>
    <div class="info-box">
      <strong>Host:</strong> ${host}<br>
      <strong>Protocol:</strong> Telegram WEB Proxy v1 (tproxy-v1)<br>
      <strong>Capability:</strong> ${bridge}
    </div>
  </div>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "X-Content-Type-Options": "nosniff"
    }
  });
}
var index_default = {
  async fetch(request, env, _ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return new Response(JSON.stringify({ ok: true, service: "telo-webproxy" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (url.pathname === "/readyz") {
      try {
        if (!env.PROXY_SECRET || !env.SESSIONS) {
          return new Response("Not ready: missing PROXY_SECRET or SESSIONS binding", {
            status: 503
          });
        }
        parseSecret(env.PROXY_SECRET);
        return new Response("ready", { status: 200 });
      } catch {
        return new Response("Not ready: invalid PROXY_SECRET format", { status: 503 });
      }
    }
    if (url.pathname === "/session/bootstrap") {
      const bridge = url.searchParams.get("bridge");
      if (!bridge) {
        return renderDecoyPage();
      }
      let canonicalHost;
      try {
        canonicalHost = canonicalizeHostname(url.hostname);
      } catch {
        return renderDecoyPage();
      }
      const isBridgeValid = await verifyBridgeCapability(bridge, env.PROXY_SECRET, canonicalHost);
      if (!isBridgeValid) {
        return renderDecoyPage();
      }
      const sessionId = crypto.randomUUID();
      const token = await signSessionToken(
        env.PROXY_SECRET,
        sessionId,
        Math.floor(Date.now() / 1e3)
      );
      return new Response(
        JSON.stringify({
          ok: true,
          token,
          sessionId,
          wsUrl: `wss://${canonicalHost}/api/v1/ws`
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store"
          }
        }
      );
    }
    if (url.pathname === "/api/v1/ws" || url.pathname === "/ws") {
      const upgradeHeader = request.headers.get("Upgrade")?.toLowerCase();
      if (upgradeHeader !== "websocket") {
        return renderDecoyPage();
      }
      let canonicalHost;
      try {
        canonicalHost = canonicalizeHostname(url.hostname);
      } catch {
        return renderDecoyPage();
      }
      let isAuthorized = false;
      let authenticatedSessionId = null;
      const subprotocol = request.headers.get("Sec-WebSocket-Protocol");
      const queryToken = url.searchParams.get("token") || url.searchParams.get("bridge");
      if (subprotocol) {
        const parts = subprotocol.split(",").map((p) => p.trim());
        for (const proto of parts) {
          const match = proto.match(/^tproxy-v1\.([A-Za-z0-9_-]+)$/);
          if (match) {
            const tokenCandidate = match[1];
            try {
              const expectedBridge = await computeBridgeCapability(
                env.PROXY_SECRET,
                canonicalHost
              );
              if (constantTimeCompare(tokenCandidate, expectedBridge)) {
                isAuthorized = true;
                break;
              }
            } catch {
            }
            const auth = await verifySessionToken(env.PROXY_SECRET, tokenCandidate, 3600);
            if (auth.valid && auth.sessionId) {
              isAuthorized = true;
              authenticatedSessionId = auth.sessionId;
              break;
            }
          }
        }
      }
      if (!isAuthorized && queryToken) {
        try {
          const expectedBridge = await computeBridgeCapability(
            env.PROXY_SECRET,
            canonicalHost
          );
          if (constantTimeCompare(queryToken, expectedBridge)) {
            isAuthorized = true;
          }
        } catch {
        }
        if (!isAuthorized) {
          const auth = await verifySessionToken(env.PROXY_SECRET, queryToken, 3600);
          if (auth.valid && auth.sessionId) {
            isAuthorized = true;
            authenticatedSessionId = auth.sessionId;
          }
        }
      }
      if (!isAuthorized) {
        const authHeader = request.headers.get("Authorization");
        if (authHeader?.startsWith("Bearer ")) {
          const bearerToken = authHeader.slice(7).trim();
          const auth = await verifySessionToken(env.PROXY_SECRET, bearerToken, 3600);
          if (auth.valid && auth.sessionId) {
            isAuthorized = true;
            authenticatedSessionId = auth.sessionId;
          }
        }
      }
      if (!isAuthorized) {
        return renderDecoyPage();
      }
      let doId;
      if (authenticatedSessionId) {
        doId = env.SESSIONS.idFromName(authenticatedSessionId);
      } else {
        doId = env.SESSIONS.newUniqueId();
      }
      const stub = env.SESSIONS.get(doId);
      const forwardHeaders = new Headers(request.headers);
      forwardHeaders.set("X-Internal-Auth", "trusted-worker");
      const forwardRequest = new Request(request.url, {
        method: request.method,
        headers: forwardHeaders
      });
      return stub.fetch(forwardRequest);
    }
    const bridgeParam = url.searchParams.get("bridge");
    if (url.pathname === "/" && bridgeParam) {
      let canonicalHost;
      try {
        canonicalHost = canonicalizeHostname(url.hostname);
      } catch {
        return renderDecoyPage();
      }
      const isValid = await verifyBridgeCapability(
        bridgeParam,
        env.PROXY_SECRET,
        canonicalHost
      );
      if (isValid) {
        return renderBridgePage(canonicalHost, bridgeParam, env.PROXY_SECRET);
      }
      return renderDecoyPage();
    }
    return renderDecoyPage();
  }
};
export {
  ProxySessionDO,
  index_default as default
};

// index.js — Official Telegram WEB Proxy v1 Worker Entry Point
import { ProxySessionDO } from './session.js';
import {
  verifyBridgeCapability,
  computeBridgeCapability,
  verifySessionToken,
  signSessionToken,
  parseSecret,
  canonicalizeHostname,
  constantTimeCompare,
  toBase64UrlNoPad,
} from './protocol.js';

export { ProxySessionDO };

function generateNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return toBase64UrlNoPad(bytes);
}

function renderDecoyPage() {
  const nonce = generateNonce();
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Network Operations Dashboard</title>
  <meta http-equiv="Content-Security-Policy" content="default-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline';">
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #090d16; color: #e2e8f0; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #111827; border: 1px solid #1f2937; border-radius: 12px; padding: 32px; max-width: 480px; width: 90%; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5); text-align: center; }
    .icon { width: 48px; height: 48px; margin: 0 auto 16px; border-radius: 50%; background: #1e293b; display: flex; align-items: center; justify-content: center; color: #38bdf8; font-weight: bold; font-size: 20px; }
    h1 { font-size: 1.25rem; font-weight: 600; margin: 0 0 8px; color: #f8fafc; }
    p { font-size: 0.875rem; color: #94a3b8; line-height: 1.5; margin: 0 0 20px; }
    .status-badge { display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px; border-radius: 9999px; background: rgba(16, 185, 129, 0.1); color: #34d399; font-size: 0.75rem; font-weight: 500; }
    .dot { width: 6px; height: 6px; border-radius: 50%; background: #10b981; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">&#10003;</div>
    <h1>Edge Gateway Active</h1>
    <p>Operational status normal. Node is running optimal telemetry and CDN health verifications.</p>
    <div class="status-badge"><span class="dot"></span> All Systems Operational</div>
  </div>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function renderBridgePage(host, bridge, proxySecret) {
  const nonce = generateNonce();
  const tmeLink = `https://t.me/webproxy?server=${encodeURIComponent(host)}&secret=${encodeURIComponent(proxySecret)}`;
  const tgLink = `tg://webproxy?server=${encodeURIComponent(host)}&secret=${encodeURIComponent(proxySecret)}`;

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
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export default {
  async fetch(request, env, _ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/healthz') {
      return new Response(JSON.stringify({ ok: true, service: 'telo-webproxy' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/readyz') {
      try {
        if (!env.PROXY_SECRET || !env.SESSIONS) {
          return new Response('Not ready: missing PROXY_SECRET or SESSIONS binding', {
            status: 503,
          });
        }
        parseSecret(env.PROXY_SECRET);
        return new Response('ready', { status: 200 });
      } catch {
        return new Response('Not ready: invalid PROXY_SECRET format', { status: 503 });
      }
    }

    if (url.pathname === '/session/bootstrap') {
      const bridge = url.searchParams.get('bridge');
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

      const token = await signSessionToken(
        env.PROXY_SECRET,
        crypto.randomUUID(),
        Math.floor(Date.now() / 1000)
      );

      return new Response(
        JSON.stringify({
          ok: true,
          token,
          wsUrl: `wss://${canonicalHost}/api/v1/ws`,
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          },
        }
      );
    }

    if (url.pathname === '/api/v1/ws' || url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return renderDecoyPage();
      }

      let canonicalHost;
      try {
        canonicalHost = canonicalizeHostname(url.hostname);
      } catch {
        return renderDecoyPage();
      }

      let isAuthorized = false;
      const subprotocol = request.headers.get('Sec-WebSocket-Protocol');
      const queryToken = url.searchParams.get('token');

      if (subprotocol) {
        const match = subprotocol.match(/tproxy-v1\.([A-Za-z0-9_-]+)/);
        if (match) {
          const providedToken = match[1];
          try {
            const expectedBridge = await computeBridgeCapability(
              env.PROXY_SECRET,
              canonicalHost
            );
            if (constantTimeCompare(providedToken, expectedBridge)) {
              isAuthorized = true;
            }
          } catch {}

          if (!isAuthorized) {
            const auth = await verifySessionToken(env.PROXY_SECRET, providedToken, 3600);
            if (auth.valid) {
              isAuthorized = true;
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
        } catch {}

        if (!isAuthorized) {
          const auth = await verifySessionToken(env.PROXY_SECRET, queryToken, 3600);
          if (auth.valid) {
            isAuthorized = true;
          }
        }
      }

      if (!isAuthorized) {
        return renderDecoyPage();
      }

      const id = env.SESSIONS.idFromName('personal-telegram-relay-v1');
      const stub = env.SESSIONS.get(id);

      const forwardHeaders = new Headers(request.headers);
      forwardHeaders.set('X-Internal-Auth', 'trusted-worker');

      const forwardRequest = new Request(request.url, {
        method: request.method,
        headers: forwardHeaders,
      });

      return stub.fetch(forwardRequest);
    }

    const bridgeParam = url.searchParams.get('bridge');
    if (url.pathname === '/' && bridgeParam) {
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
  },
};

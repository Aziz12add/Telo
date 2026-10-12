// src/worker/index.ts
// Telegram Official WEB Proxy v1 Worker Entrypoint for Cloudflare Workers
// Single source of truth for edge routing, capability authentication, and DO session dispatch.

import {
  parseSecret,
  canonicalizeHostname,
  computeBridgeCapability,
  verifyBridgeCapability,
  signSessionToken,
  verifySessionToken,
  constantTimeCompare,
} from './protocol.ts';
import { ProxySessionDO } from './session.ts';

export { ProxySessionDO };

export interface Env {
  PROXY_SECRET: string;
  SESSIONS: DurableObjectNamespace;
}

/**
 * Returns a minimal decoy 404 response to blend in with normal web traffic.
 */
function renderDecoyPage(): Response {
  return new Response('404 Not Found', {
    status: 404,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/**
 * Generates the official Telegram WEB Proxy Bridge HTML landing page.
 */
function renderBridgePage(host: string, bridge: string, secret: string): Response {
  const nonce = crypto.randomUUID().replace(/-/g, '');
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
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Health check endpoint
    if (url.pathname === '/healthz') {
      return new Response(JSON.stringify({ ok: true, service: 'telo-webproxy' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Readiness check endpoint
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

    // Session bootstrap endpoint (used by Web Proxy clients to acquire session tokens)
    if (url.pathname === '/session/bootstrap') {
      const bridge = url.searchParams.get('bridge');
      if (!bridge) {
        return renderDecoyPage();
      }

      let canonicalHost: string;
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
        Math.floor(Date.now() / 1000)
      );

      return new Response(
        JSON.stringify({
          ok: true,
          token,
          sessionId,
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

    // Official WebSocket endpoints: /api/v1/ws and backwards-compatible /ws
    if (url.pathname === '/api/v1/ws' || url.pathname === '/ws') {
      const upgradeHeader = request.headers.get('Upgrade')?.toLowerCase();
      if (upgradeHeader !== 'websocket') {
        return renderDecoyPage();
      }

      let canonicalHost: string;
      try {
        canonicalHost = canonicalizeHostname(url.hostname);
      } catch {
        return renderDecoyPage();
      }

      let isAuthorized = false;
      let authenticatedSessionId: string | null = null;

      const subprotocol = request.headers.get('Sec-WebSocket-Protocol');
      const queryToken = url.searchParams.get('token') || url.searchParams.get('bridge');

      // 1. Verify Sec-WebSocket-Protocol: tproxy-v1.<token>
      if (subprotocol) {
        const parts = subprotocol.split(',').map((p) => p.trim());
        for (const proto of parts) {
          const match = proto.match(/^tproxy-v1\.([A-Za-z0-9_-]+)$/);
          if (match) {
            const tokenCandidate = match[1];

            // Check if tokenCandidate is the direct bridge capability
            try {
              const expectedBridge = await computeBridgeCapability(
                env.PROXY_SECRET,
                canonicalHost
              );
              if (constantTimeCompare(tokenCandidate, expectedBridge)) {
                isAuthorized = true;
                break;
              }
            } catch {}

            // Check if tokenCandidate is a signed session token
            const auth = await verifySessionToken(env.PROXY_SECRET, tokenCandidate, 3600);
            if (auth.valid && auth.sessionId) {
              isAuthorized = true;
              authenticatedSessionId = auth.sessionId;
              break;
            }
          }
        }
      }

      // 2. Verify query string (?token= or ?bridge=)
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
          if (auth.valid && auth.sessionId) {
            isAuthorized = true;
            authenticatedSessionId = auth.sessionId;
          }
        }
      }

      // 3. Verify Authorization: Bearer <token>
      if (!isAuthorized) {
        const authHeader = request.headers.get('Authorization');
        if (authHeader?.startsWith('Bearer ')) {
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

      // Route to an isolated Durable Object per session / connection
      // NEVER share a single singleton DO across distinct clients
      let doId: DurableObjectId;
      if (authenticatedSessionId) {
        doId = env.SESSIONS.idFromName(authenticatedSessionId);
      } else {
        doId = env.SESSIONS.newUniqueId();
      }

      const stub = env.SESSIONS.get(doId);
      const forwardHeaders = new Headers(request.headers);
      forwardHeaders.set('X-Internal-Auth', 'trusted-worker');

      const forwardRequest = new Request(request.url, {
        method: request.method,
        headers: forwardHeaders,
      });

      return stub.fetch(forwardRequest);
    }

    // Bridge landing page: GET /?bridge=<capability>
    const bridgeParam = url.searchParams.get('bridge');
    if (url.pathname === '/' && bridgeParam) {
      let canonicalHost: string;
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

    // Default: Decoy page for any unauthenticated or unrecognized route
    return renderDecoyPage();
  },
};

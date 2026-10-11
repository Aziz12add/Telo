// index.js
// Cloudflare Worker router & bridge controller for Telegram Web Proxy v1

import { ProxySessionDO } from './session.js';
import {
  verifyBridgeCapability,
  signSessionToken,
  toBase64UrlNoPad,
} from './protocol.js';

export { ProxySessionDO };

function generateNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return toBase64UrlNoPad(bytes);
}

function getBaseSecurityHeaders() {
  return {
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'no-referrer',
  };
}

function renderDecoyPage() {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Welcome to nginx!</title>
  <style>
    body { width: 35em; margin: 0 auto; font-family: Tahoma, Verdana, Arial, sans-serif; padding-top: 10%; }
  </style>
</head>
<body>
  <h1>Welcome to nginx!</h1>
  <p>If you see this page, the nginx web server is successfully installed and working. Further configuration is required.</p>
  <p><em>Thank you for using nginx.</em></p>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      ...getBaseSecurityHeaders(),
    },
  });
}

function renderBridgeHtml(nonce, hostname, token, wsUrl, connectionLink) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Telegram Web Proxy Bridge v1</title>
  <style nonce="${nonce}">
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: #0f172a;
      color: #f8fafc;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
    }
    .card {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 12px;
      max-width: 520px;
      width: 100%;
      padding: 24px;
      box-shadow: 0 10px 25px -5px rgba(0,0,0,0.5);
    }
    .badge {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 9999px;
      font-size: 12px;
      font-weight: 600;
      background: #065f46;
      color: #6ee7b7;
      margin-bottom: 16px;
    }
    h1 { font-size: 20px; margin-bottom: 8px; color: #38bdf8; }
    p { font-size: 14px; color: #94a3b8; line-height: 1.5; margin-bottom: 16px; }
    .box {
      background: #0f172a;
      border: 1px solid #1e293b;
      border-radius: 8px;
      padding: 12px;
      margin-bottom: 16px;
      font-family: monospace;
      font-size: 13px;
      word-break: break-all;
      color: #e2e8f0;
    }
    .btn {
      display: block;
      width: 100%;
      padding: 12px;
      background: #0284c7;
      color: #ffffff;
      text-align: center;
      text-decoration: none;
      font-size: 14px;
      font-weight: 600;
      border-radius: 8px;
      margin-bottom: 10px;
    }
    .btn:hover { background: #0369a1; }
    #log { font-family: monospace; font-size: 12px; color: #38bdf8; margin-top: 8px; }
  </style>
</head>
<body>
  <div class="card">
    <span class="badge" id="statusBadge">Bridge Initializing</span>
    <h1>Telegram Web Proxy Bridge v1</h1>
    <p>Secure, authenticated WebSocket bridge for Telegram client connections.</p>
    
    <div class="box">
      <strong>Host:</strong> ${hostname}<br>
      <strong>Protocol:</strong> Web Proxy v1 (Big-Endian Frames)
    </div>

    <a href="${connectionLink}" class="btn">Connect in Telegram</a>

    <div class="box" id="log">Connecting WebSocket...</div>
  </div>

  <script nonce="${nonce}">
    (function() {
      const wsUrl = ${JSON.stringify(wsUrl)};
      const logEl = document.getElementById('log');
      const badgeEl = document.getElementById('statusBadge');

      function notifyAndroid(event, data) {
        if (window.TelegramWebProxy && typeof window.TelegramWebProxy.postMessage === 'function') {
          try {
            window.TelegramWebProxy.postMessage(JSON.stringify({ event, data }));
          } catch(e) {}
        }
      }

      function log(msg) {
        if (logEl) logEl.textContent = msg;
      }

      try {
        const ws = new WebSocket(wsUrl);
        ws.binaryType = 'arraybuffer';

        ws.onopen = function() {
          log('WebSocket connected. Sending HELLO frame...');
          badgeEl.textContent = 'Connected';
          badgeEl.style.background = '#065f46';
          badgeEl.style.color = '#6ee7b7';

          // Frame: [1B type=0x01][2B streamId=0][1B flags=0][4B payloadLen=0]
          const hello = new Uint8Array(8);
          hello[0] = 0x01; // HELLO
          ws.send(hello);

          notifyAndroid('connected', { host: location.hostname });
        };

        ws.onmessage = function(event) {
          if (event.data instanceof ArrayBuffer) {
            const view = new DataView(event.data);
            if (view.byteLength >= 8) {
              const type = view.getUint8(0);
              const streamId = view.getUint16(1, false);
              if (type === 0x02) {
                log('Received WELCOME frame from Durable Object. Ready.');
                notifyAndroid('welcome', { streamId });
              }
            }
          }
        };

        ws.onerror = function() {
          log('WebSocket connection error.');
          badgeEl.textContent = 'Error';
          badgeEl.style.background = '#991b1b';
          badgeEl.style.color = '#fca5a5';
          notifyAndroid('error', {});
        };

        ws.onclose = function() {
          log('WebSocket connection closed.');
          notifyAndroid('closed', {});
        };
      } catch (err) {
        log('Error: ' + err.message);
      }
    })();
  </script>
</body>
</html>`;

  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self' wss://${hostname}; img-src 'self' data:;`,
    ...getBaseSecurityHeaders(),
  };

  return new Response(html, { status: 200, headers });
}

export default {
  /**
   * Main fetch router
   * @param {Request} request
   * @param {{ PROXY_SECRET: string, SESSIONS: DurableObjectNamespace }} env
   * @param {ExecutionContext} ctx
   * @returns {Promise<Response>}
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const hostname = request.headers.get('host') || url.host;

    // 1. Health check
    if (url.pathname === '/healthz') {
      return new Response(
        JSON.stringify({
          ok: true,
          service: 'telegram-web-proxy-v1',
          host: hostname,
          timestamp: Math.floor(Date.now() / 1000),
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            ...getBaseSecurityHeaders(),
          },
        }
      );
    }

    const secret = env.PROXY_SECRET;
    if (!secret) {
      return new Response('Configuration Error: PROXY_SECRET not set', {
        status: 500,
        headers: getBaseSecurityHeaders(),
      });
    }

    // 2. WebSocket upgrade request -> routed to Durable Object
    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }

      const token = url.searchParams.get('token');
      if (!token) {
        return new Response('Unauthorized: missing token', { status: 401 });
      }

      const sessionId = token.split('.')[0] || 'default';
      const doId = env.SESSIONS.idFromName(sessionId);
      const doStub = env.SESSIONS.get(doId);

      return doStub.fetch(request);
    }

    // 3. Session bootstrap endpoint
    if (url.pathname === '/session/bootstrap' || url.pathname === '/api/session') {
      if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
      }

      const sessionId = crypto.randomUUID();
      const timestamp = Math.floor(Date.now() / 1000);
      const token = await signSessionToken(secret, sessionId, timestamp);

      return new Response(
        JSON.stringify({
          ok: true,
          sessionId,
          token,
          wsUrl: `wss://${hostname}/ws?token=${encodeURIComponent(token)}`,
          host: hostname,
          port: 443,
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            ...getBaseSecurityHeaders(),
          },
        }
      );
    }

    // 4. Main route: GET /?bridge=...
    if (url.pathname === '/') {
      const providedBridge = url.searchParams.get('bridge');

      // Verify HMAC bridge capability against the request hostname
      if (providedBridge && (await verifyBridgeCapability(providedBridge, secret, hostname))) {
        const nonce = generateNonce();
        const sessionId = crypto.randomUUID();
        const timestamp = Math.floor(Date.now() / 1000);
        const token = await signSessionToken(secret, sessionId, timestamp);
        const wsUrl = `wss://${hostname}/ws?token=${encodeURIComponent(token)}`;

        // Canonical link format: https://t.me/webproxy?server=HOSTNAME&secret=SECRET
        const connectionLink = `https://t.me/webproxy?server=${encodeURIComponent(hostname)}&secret=${encodeURIComponent(secret)}`;

        return renderBridgeHtml(nonce, hostname, token, wsUrl, connectionLink);
      }

      // If bridge param is missing or HMAC verification fails -> Decoy page
      return renderDecoyPage();
    }

    // All other endpoints -> Decoy page with 404
    return new Response('Not Found', {
      status: 404,
      headers: getBaseSecurityHeaders(),
    });
  },
};

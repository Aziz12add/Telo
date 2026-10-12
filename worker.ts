/// <reference types="@cloudflare/workers-types" />

import { ProxySessionDO } from './session.js';
import {
  parseSecret,
  computeBridgeCapability,
  constantTimeCompare,
  toBase64UrlNoPad,
} from './protocol.js';

export { ProxySessionDO };

export interface Env {
  PROXY_SECRET: string;
  RELAY: DurableObjectNamespace;
}

function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return toBase64UrlNoPad(bytes);
}

function canonicalizeHostname(rawHost: string | null): string | null {
  if (!rawHost || typeof rawHost !== 'string') return null;

  let host = rawHost.trim().toLowerCase();
  if (host.includes(':')) {
    host = host.split(':')[0];
  }

  // Reject IPv4 literals
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) {
    return null;
  }

  // Reject IPv6 literals
  if (host.includes('[') || host.includes(']')) {
    return null;
  }

  try {
    const parsed = new URL(`https://${host}`);
    const asciiHost = parsed.hostname.toLowerCase();
    if (!asciiHost || asciiHost.length < 3 || !asciiHost.includes('.')) {
      return null;
    }
    return asciiHost;
  } catch {
    return null;
  }
}

function renderDecoyPage(): Response {
  const nonce = generateNonce();
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Welcome to nginx!</title>
  <style nonce="${nonce}">
    body { width: 35em; margin: 0 auto; font-family: Tahoma, Verdana, Arial, sans-serif; padding-top: 10%; color: #333; }
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
      'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none';`,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // 1. GET /healthz -> 200 ok
    if (url.pathname === '/healthz' && request.method === 'GET') {
      return new Response('ok', {
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
        },
      });
    }

    // 2. GET /readyz -> check env.PROXY_SECRET and env.RELAY binding, try parseSecret
    if (url.pathname === '/readyz' && request.method === 'GET') {
      if (!env.PROXY_SECRET || !env.RELAY) {
        return new Response('not ready: missing bindings', {
          status: 503,
          headers: { 'Cache-Control': 'no-store' },
        });
      }

      try {
        parseSecret(env.PROXY_SECRET);
      } catch {
        return new Response('not ready: invalid secret', {
          status: 503,
          headers: { 'Cache-Control': 'no-store' },
        });
      }

      return new Response('ready', {
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      });
    }

    // 3. GET /api/v1/ws -> WebSocket endpoint
    if (url.pathname === '/api/v1/ws') {
      const upgradeHeader = request.headers.get('Upgrade');
      if (upgradeHeader !== 'websocket') {
        return renderDecoyPage();
      }

      const hostHeader = request.headers.get('Host') || url.host;
      const canonicalHost = canonicalizeHostname(hostHeader);
      if (!canonicalHost) {
        return renderDecoyPage();
      }

      if (!env.PROXY_SECRET || !env.RELAY) {
        return renderDecoyPage();
      }

      // Validate Sec-WebSocket-Protocol: tproxy-v1.<token>
      const protocols = request.headers.get('Sec-WebSocket-Protocol');
      if (!protocols) {
        return renderDecoyPage();
      }

      const match = protocols.split(',').map((p) => p.trim()).find((p) => p.startsWith('tproxy-v1.'));
      if (!match) {
        return renderDecoyPage();
      }

      const token = match.slice('tproxy-v1.'.length);
      if (!token) {
        return renderDecoyPage();
      }

      let expectedToken: string;
      try {
        expectedToken = await computeBridgeCapability(env.PROXY_SECRET, canonicalHost);
      } catch {
        return renderDecoyPage();
      }

      if (!constantTimeCompare(token, expectedToken)) {
        return renderDecoyPage();
      }

      // Validated: forward to DO with internal header X-Internal-Auth: trusted-worker
      const doId = env.RELAY.idFromName('personal-telegram-relay-v1');
      const stub = env.RELAY.get(doId);

      const forwardHeaders = new Headers();
      forwardHeaders.set('Upgrade', 'websocket');
      forwardHeaders.set('Connection', 'Upgrade');
      forwardHeaders.set('X-Internal-Auth', 'trusted-worker');

      const wsKey = request.headers.get('Sec-WebSocket-Key');
      if (wsKey) forwardHeaders.set('Sec-WebSocket-Key', wsKey);

      const wsVersion = request.headers.get('Sec-WebSocket-Version');
      if (wsVersion) forwardHeaders.set('Sec-WebSocket-Version', wsVersion);

      const forwardRequest = new Request(request.url, {
        method: request.method,
        headers: forwardHeaders,
      });

      return stub.fetch(forwardRequest);
    }

    // All invalid/unknown requests return decoy page with status 200
    return renderDecoyPage();
  },
};

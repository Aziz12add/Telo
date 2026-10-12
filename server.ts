// server.ts - FIXED FINAL for Telo
import { ProxySessionDO } from './session.js';
import { computeBridgeCapability, constantTimeCompare, parseSecret } from './protocol.js';

export { ProxySessionDO };

export interface Env {
  PROXY_SECRET: string;
  RELAY: DurableObjectNamespace;
}

function generateNonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  // fast base64url without spread overflow
  let bin = '';
  b.forEach(v => bin += String.fromCharCode(v));
  return btoa(bin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

function canonicalizeHostname(rawHost: string): string | null {
  if (!rawHost) return null;
  let host = rawHost.trim().toLowerCase().split(':')[0];
  // reject IPv4
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return null;
  // reject IPv6
  if (host.includes('[') || host.includes(']') || host.includes('::')) return null;
  try {
    const ascii = new URL(`https://${host}`).hostname.toLowerCase();
    if (!ascii.includes('.') || ascii.length < 3) return null;
    return ascii;
  } catch {
    return null;
  }
}

function renderDecoyPage(): Response {
  const nonce = generateNonce();
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Minimal Notes</title>
<style nonce="${nonce}">
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.7;max-width:680px;margin:60px auto;padding:0 24px;color:#1e293b;background:#f8fafc}
h1{font-size:22px;font-weight:700}.meta{color:#64748b;font-size:13px}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:20px;margin:24px 0}
@media(prefers-color-scheme:dark){body{color:#cbd5e1;background:#0f172a}.card{background:#1e293b;border-color:#334155}}
</style></head><body>
<h1>Minimal Notes</h1><p class="meta">Observations on distributed state & edge isolation.</p>
<div class="card"><h2>Transient Streaming</h2><p>Modern edge bridges keep crypto state in-memory only to preserve forward secrecy. Durable persistence is limited to session metadata, not keystream counters.</p></div>
<div class="card"><h2>Multiplexed Backpressure</h2><p>Independent stream windows prevent head-of-line blocking. Each stream maintains its own 4MiB window.</p></div>
<footer style="margin-top:40px;color:#94a3b8;font-size:12px">© ${new Date().getFullYear()} Minimal Notes</footer>
</body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'`
    }
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/healthz') {
      return new Response('ok', { status: 200, headers: { 'Content-Type': 'text/plain' } });
    }

    if (path === '/readyz') {
      if (!env.PROXY_SECRET ||!env.RELAY) {
        return new Response('Missing bindings', { status: 503 });
      }
      try {
        parseSecret(env.PROXY_SECRET);
        return new Response('ready', { status: 200 });
      } catch {
        return new Response('Invalid PROXY_SECRET format (need 32 hex or dd+32 hex)', { status: 503 });
      }
    }

    // WebSocket
    if (path === '/api/v1/ws') {
      if (request.headers.get('Upgrade')!== 'websocket') return renderDecoyPage();

      const rawHost = request.headers.get('Host') || url.host;
      const canonicalHost = canonicalizeHostname(rawHost);
      if (!canonicalHost ||!env.PROXY_SECRET ||!env.RELAY) return renderDecoyPage();

      const protoHeader = request.headers.get('Sec-WebSocket-Protocol') || '';
      // Header can be: "tproxy-v1.<token>, other" - extract first matching
      const match = protoHeader.split(',').map(s=>s.trim()).find(s=>s.startsWith('tproxy-v1.'));
      if (!match) return renderDecoyPage();

      const providedToken = match.slice('tproxy-v1.'.length).trim();
      if (!providedToken) return renderDecoyPage();

      // FIXED: Use same formula as protocol.js
      let expectedToken: string;
      try {
        expectedToken = await computeBridgeCapability(env.PROXY_SECRET, canonicalHost);
      } catch {
        return renderDecoyPage();
      }

      if (!constantTimeCompare(providedToken, expectedToken)) {
        return renderDecoyPage();
      }

      // Valid - forward to DO with internal trusted header
      const doId = env.RELAY.idFromName('personal-telegram-relay-v1');
      const stub = env.RELAY.get(doId);

      const headers = new Headers();
      headers.set('Upgrade', 'websocket');
      headers.set('Connection', 'Upgrade');
      headers.set('Sec-WebSocket-Key', request.headers.get('Sec-WebSocket-Key') || '');
      headers.set('Sec-WebSocket-Version', request.headers.get('Sec-WebSocket-Version') || '13');
      headers.set('X-Internal-Auth', 'trusted-worker');
      headers.set('X-Forwarded-Host', canonicalHost);

      return stub.fetch(new Request('https://relay.internal/ws', {
        method: 'GET',
        headers
      }));
    }

    return renderDecoyPage();
  }
};

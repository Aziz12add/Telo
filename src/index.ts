// ============================================================
// Telegram WEB proxy v1 - Worker entry point (Cloudflare Workers)
//
//   GET    /?bridge=<capability>  -> bridge page (only with the valid capability)
//   POST   /api/v1/session        -> bootstrap token + HELLO  =>  session token + WELCOME
//   GET    /api/v1/ws             -> WebSocket upgrade (subprotocol tproxy-v1.<token>)
//   DELETE /api/v1/session        -> close the session
//   everything else               -> the public site / 404, identical to what a
//                                    prober without the secret sees
//
// Secrets: PROXY_SECRET  (wrangler secret put PROXY_SECRET)  32 hex chars, optional dd prefix
// ============================================================
import { WebSocketProxy } from './WebSocketProxy';
import {
  FrameType, parseBatch, buildWelcome, decodeSecret, bridgeCapability, safeEqual,
} from './protocol';
import { mintBootstrap, verifyBootstrap, deriveSession, verifySession, b64urlEncode } from './tokens';
import { bridgeHtml } from './bridge';

export { WebSocketProxy };

interface Env {
  WEBSOCKET_PROXY: DurableObjectNamespace;
  PROXY_SECRET: string;
}

// ---- Public face: replace with your real site ----
const PUBLIC_HOME =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Welcome</title></head>' +
  '<body><h1>Welcome</h1><p>Nothing to see here yet.</p></body></html>';

const html = (body: string, status: number): Response =>
  new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });

const publicHome = (): Response => html(PUBLIC_HOME, 200);
const notFound = (): Response =>
  html('<!doctype html><title>404</title><h1>404 Not Found</h1>', 404);

const bearer = (req: Request): string | null => {
  const m = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.get('Authorization') ?? '');
  return m ? m[1] : null;
};

const bridgeResponse = async (host: string, bootstrap: string): Promise<Response> => {
  const nonce = b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
  const csp = [
    "default-src 'none'", "base-uri 'none'", "child-src 'none'",
    `connect-src 'self' wss://${host}`,
    "font-src 'none'", "form-action 'none'", 'frame-ancestors http://127.0.0.1:*',
    "frame-src 'none'", "img-src 'none'", "manifest-src 'none'", "media-src 'none'",
    "object-src 'none'", `script-src 'nonce-${nonce}'`, "style-src 'none'", "worker-src 'none'",
    'sandbox allow-same-origin allow-scripts',
  ].join('; ');
  return new Response(bridgeHtml({ host, bootstrap, nonce }), {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': csp,
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  });
};

const createSession = async (req: Request, secret: Uint8Array): Promise<Response> => {
  if (req.headers.has('Cookie')) return notFound();
  const token = bearer(req);
  if (!token) return notFound();
  const boot = await verifyBootstrap(secret, token);
  if (!boot) return notFound();

  const declared = Number(req.headers.get('Content-Length') ?? '0');
  if (!(declared >= 8 && declared <= 64)) return notFound();
  const body = new Uint8Array(await req.arrayBuffer());
  try {
    const frames = parseBatch(body, 'from-client');
    if (frames.length !== 1 || frames[0].type !== FrameType.HELLO) return notFound();
  } catch {
    return notFound();
  }

  const session = await deriveSession(secret, boot);
  return new Response(buildWelcome() as Uint8Array<ArrayBuffer>, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Session-Token': session.token,
      'X-Down-Cursor': '0',
      'X-Carrier-Mode': 'websocket',
    },
  });
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let secret: Uint8Array;
    try {
      secret = decodeSecret(env.PROXY_SECRET);
    } catch {
      console.error('PROXY_SECRET missing or invalid');
      return notFound();
    }

    const url = new URL(request.url);
    const method = request.method;

    // Bridge page: exactly "/?bridge=<43 chars>"
    if (url.pathname === '/' && method === 'GET') {
      const m = /^\?bridge=([A-Za-z0-9_-]{43})$/.exec(url.search);
      if (m && safeEqual(m[1], await bridgeCapability(secret, url.hostname))) {
        return bridgeResponse(url.hostname, await mintBootstrap(secret));
      }
      return publicHome();
    }

    if (url.pathname === '/api/v1/session' && method === 'POST') {
      return createSession(request, secret);
    }

    if (url.pathname === '/api/v1/session' && method === 'DELETE') {
      const token = bearer(request);
      const sid = token ? await verifySession(secret, token) : null;
      if (!sid) return notFound();
      const stub = env.WEBSOCKET_PROXY.get(env.WEBSOCKET_PROXY.idFromName(sid));
      await stub.fetch('https://session/close', { method: 'POST' });
      return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
    }

    if (url.pathname === '/api/v1/ws' && method === 'GET') {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return notFound();
      const offered = (request.headers.get('Sec-WebSocket-Protocol') ?? '')
        .split(',').map((p) => p.trim()).find((p) => p.startsWith('tproxy-v1.'));
      const sid = offered ? await verifySession(secret, offered.slice('tproxy-v1.'.length)) : null;
      if (!sid) return notFound();
      const stub = env.WEBSOCKET_PROXY.get(env.WEBSOCKET_PROXY.idFromName(sid));
      return stub.fetch(request);
    }

    return notFound();
  },
} satisfies ExportedHandler<Env>;

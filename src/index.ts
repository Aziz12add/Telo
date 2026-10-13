export { WebSocketProxy } from './WebSocketProxy';

interface Env {
  WEBSOCKET_PROXY: DurableObjectNamespace;
}

const DC_LOCATION_HINT: Record<number, DurableObjectLocationHint> = {
  1: 'enam', 2: 'weur', 3: 'enam', 4: 'weur', 5: 'apac',
};

const VALID_DC_IDS = new Set([1, 2, 3, 4, 5]);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // ---- Health check ----
    if (url.pathname === '/' || url.pathname === '/health') {
      return Response.json({
        status: 'ok',
        service: 'Telo — Telegram WEB Proxy v1',
        protocol: 'binary, big-endian, HMAC-SHA256',
        usage: 'wss://<worker-host>/apiws?secret=<32hex>&dc=<1-5>',
      });
    }

    // ---- Only /apiws handles WebSocket ----
    if (url.pathname !== '/apiws') {
      return new Response('Not found', { status: 404 });
    }

    // ---- WebSocket upgrade check ----
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    // ---- Validate secret ----
    const secret = url.searchParams.get('secret');
    if (!secret || !/^[0-9a-fA-F]{32}$/.test(secret)) {
      return new Response('Missing or invalid secret', { status: 400 });
    }

    // ---- Validate dc (strictly 1..5) ----
    const dc = parseInt(url.searchParams.get('dc') ?? '2', 10);
    if (!VALID_DC_IDS.has(dc)) {
      return new Response('dc must be an integer in 1..5', { status: 400 });
    }

    // ---- Route to Durable Object ----
    // One DO per (dc, secret) so multiple DCs don't collide.
    const hint = DC_LOCATION_HINT[dc] ?? 'weur';
    const id = env.WEBSOCKET_PROXY.idFromName(`${dc}:${secret}`);
    const stub = env.WEBSOCKET_PROXY.get(id, { locationHint: hint });

    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;

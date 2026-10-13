export { WebSocketProxy } from './WebSocketProxy';

interface Env {
  WEBSOCKET_PROXY: DurableObjectNamespace;
}

const DC_LOCATION_HINT: Record<number, DurableObjectLocationHint> = {
  1: 'enam', 2: 'weur', 3: 'enam', 4: 'weur', 5: 'apac',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response(JSON.stringify({
        status: 'ok',
        service: 'Telo — Telegram WEB Proxy v1',
        protocol: 'binary, big-endian, HMAC-SHA256',
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    // WebSocket upgrade check
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    // Secret required for routing (also used by DO)
    const secret = url.searchParams.get('secret');
    if (!secret || !/^[0-9a-fA-F]{32}$/.test(secret)) {
      return new Response('Missing or invalid secret', { status: 400 });
    }

    // Pick a DC location hint (default to DC2 = Amsterdam / weur)
    const dcParam = url.searchParams.get('dc') ?? '2';
    const dc = parseInt(dcParam, 10);
    const hint = DC_LOCATION_HINT[dc] ?? 'weur';

    // DO id derived from secret (one DO per secret = one persistent session space)
    const id = env.WEBSOCKET_PROXY.idFromName(secret);
    const stub = env.WEBSOCKET_PROXY.get(id, { locationHint: hint });

    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;

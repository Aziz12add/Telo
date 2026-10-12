// index.js — Worker router (bridge + session + ws → DO)
import { ProxySessionDO } from './session.js';
import {
  verifyBridgeCapability,
  signSessionToken,
  toBase64UrlNoPad,
} from './protocol.js';

export { ProxySessionDO };

function nonce() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return toBase64UrlNoPad(b);
}

function decoy() {
  return new Response(
    `<!doctype html><meta charset=utf-8><title>OK</title><p>OK</p>`,
    {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    }
  );
}

function bridgePage(n, host, token, wsUrl, link) {
  const html = `<!DOCTYPE html><html><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>Telegram WEB Proxy Bridge</title>
<style nonce="${n}">body{font-family:system-ui;background:#0f172a;color:#e2e8f0;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{background:#1e293b;border-radius:12px;padding:24px;max-width:420px;width:90%}
a{display:block;text-align:center;background:#0284c7;color:#fff;text-decoration:none;padding:12px;border-radius:8px;margin-top:12px}
#log{font:12px monospace;margin-top:12px;color:#38bdf8}</style></head>
<body><div class=card>
<h1>WEB Proxy Bridge</h1>
<p>Host: ${host}</p>
<a href="${link}">Open in Telegram</a>
<div id=log>Connecting…</div>
</div>
<script nonce="${n}">
(function(){
  var ws=new WebSocket(${JSON.stringify(wsUrl)});
  ws.binaryType='arraybuffer';
  var log=document.getElementById('log');
  ws.onopen=function(){
    log.textContent='WS open, HELLO';
    var h=new Uint8Array(8); h[0]=0x01; ws.send(h);
  };
  ws.onmessage=function(e){
    if(e.data && e.data.byteLength>=1){
      var t=new DataView(e.data).getUint8(0);
      if(t===0x02) log.textContent='WELCOME — ready';
    }
  };
  ws.onerror=function(){ log.textContent='WS error'; };
})();
</script></body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-\( {n}'; style-src 'nonce- \){n}'; connect-src 'self' wss://${host}`,
      'Cache-Control': 'no-store',
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const host = (request.headers.get('host') || url.host).split(':')[0].toLowerCase();

    if (url.pathname === '/healthz') {
      return new Response(JSON.stringify({ ok: true, service: 'telo-webproxy' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!env.PROXY_SECRET) {
      return new Response('PROXY_SECRET missing', { status: 500 });
    }

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 });
      }
      const token = url.searchParams.get('token');
      if (!token) return new Response('missing token', { status: 401 });
      const sessionId = token.split('.')[0] || 'default';
      const id = env.SESSIONS.idFromName(sessionId);
      return env.SESSIONS.get(id).fetch(request);
    }

    if (url.pathname === '/session/bootstrap' && request.method === 'POST') {
      const sessionId = crypto.randomUUID();
      const timestamp = Math.floor(Date.now() / 1000);
      const token = await signSessionToken(env.PROXY_SECRET, sessionId, timestamp);
      return new Response(
        JSON.stringify({
          ok: true,
          token,
          wsUrl: `wss://\( {host}/ws?token= \){encodeURIComponent(token)}`,
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (url.pathname === '/') {
      const bridge = url.searchParams.get('bridge');
      if (bridge && (await verifyBridgeCapability(bridge, env.PROXY_SECRET, host))) {
        const sessionId = crypto.randomUUID();
        const timestamp = Math.floor(Date.now() / 1000);
        const token = await signSessionToken(env.PROXY_SECRET, sessionId, timestamp);
        const wsUrl = `wss://\( {host}/ws?token= \){encodeURIComponent(token)}`;
        const link = `https://t.me/webproxy?server=\( {encodeURIComponent(host)}&secret= \){encodeURIComponent(env.PROXY_SECRET)}`;
        return bridgePage(nonce(), host, token, wsUrl, link);
      }
      return decoy();
    }

    return decoy();
  },
};

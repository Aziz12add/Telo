/**
 * Cloudflare Worker Main Entry Point
 * Exposes:
 * - GET /: Public panel showing host, port 443, proxy secret, one-click links, health check
 * - GET /healthz: Status endpoint
 * - GET /api/session: Mint HMAC signed bootstrap token for web proxy / client bridge
 * - /ws: WebSocket route routed to ProxySessionDO Durable Object
 * - Camouflage 404 for invalid requests
 */

import { ProxySessionDO, Env } from './session';
import { signSessionToken } from './protocol';

export { ProxySessionDO };

export default {
  async fetch(request: Request, env: Env, ctx: any): Promise<Response> {
    const url = new URL(request.url);
    const host = env.PUBLIC_HOSTNAME || request.headers.get('host') || url.host;

    // Security Headers Helper
    const securityHeaders = {
      'Content-Security-Policy': "default-src 'self' 'unsafe-inline' https: data:; connect-src 'self' wss: https:;",
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin'
    };

    // 1. Health check
    if (url.pathname === '/healthz') {
      return new Response(JSON.stringify({
        ok: true,
        service: 'telo-telegram-proxy',
        version: '2.5.0',
        host,
        timestamp: Math.floor(Date.now() / 1000)
      }), {
        headers: {
          'Content-Type': 'application/json',
          ...securityHeaders
        }
      });
    }

    // 2. Mint session token for Telegram Web Proxy bridge
    if (url.pathname === '/api/session') {
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 });
      }

      const sessionId = crypto.randomUUID();
      const ts = Math.floor(Date.now() / 1000);
      const token = await signSessionToken(env.PROXY_SECRET, sessionId, ts);

      return new Response(JSON.stringify({
        ok: true,
        sessionId,
        token,
        wsUrl: `wss://${host}/ws?token=${encodeURIComponent(token)}&dc=2`,
        host,
        port: 443
      }), {
        headers: {
          'Content-Type': 'application/json',
          ...securityHeaders
        }
      });
    }

    // 3. WebSocket session routing to Durable Object
    if (url.pathname === '/ws') {
      const token = url.searchParams.get('token');
      if (!token) {
        return new Response('Missing session token', { status: 401 });
      }

      // Extract sessionId from token (sessionId.ts.sig)
      const sessionId = token.split('.')[0] || 'default';
      const id = env.SESSIONS.idFromName(sessionId);
      const obj = env.SESSIONS.get(id);

      return obj.fetch(request);
    }

    // 4. Diagnostic status or Landing page
    if (url.pathname === '/') {
      const secret = env.PROXY_SECRET;
      const cleanSecret = secret.startsWith('dd') ? secret : `dd${secret}`;
      const tgDeepLink = `tg://proxy?server=${host}&port=443&secret=${cleanSecret}`;
      const tgWebLink = `https://t.me/proxy?server=${host}&port=443&secret=${cleanSecret}`;
      const webProxyBridgeUrl = `https://${host}/api/session`;

      const html = `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Telo - Telegram Proxy on Cloudflare Workers</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #090d16;
      color: #f1f5f9;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      padding: 16px;
    }
    .card {
      background: #111827;
      border: 1px solid #1f2937;
      border-radius: 16px;
      max-width: 580px;
      width: 100%;
      padding: 28px;
      box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5);
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 9999px;
      font-size: 12px;
      font-weight: 600;
      background: #064e3b;
      color: #34d399;
      border: 1px solid #059669;
      margin-bottom: 16px;
    }
    .pulse { width: 8px; height: 8px; border-radius: 50%; background: #10b981; animation: pulse 2s infinite; }
    @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.3; } 100% { opacity: 1; } }
    h1 { font-size: 20px; font-weight: 700; color: #38bdf8; margin-bottom: 8px; }
    p.desc { font-size: 13px; color: #94a3b8; line-height: 1.6; margin-bottom: 20px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 20px; }
    .box { background: #0b0f19; border: 1px solid #1e293b; border-radius: 10px; padding: 12px; }
    .box-title { font-size: 11px; color: #64748b; margin-bottom: 4px; }
    .box-val { font-family: monospace; font-size: 13px; color: #e2e8f0; direction: ltr; text-align: left; word-break: break-all; }
    .btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      width: 100%;
      padding: 12px;
      border-radius: 10px;
      font-size: 14px;
      font-weight: 600;
      text-decoration: none;
      cursor: pointer;
      transition: all 0.2s;
      border: none;
      margin-bottom: 10px;
    }
    .btn-primary { background: #0284c7; color: white; }
    .btn-primary:hover { background: #0369a1; }
    .btn-secondary { background: #1e293b; color: #cbd5e1; border: 1px solid #334155; }
    .btn-secondary:hover { background: #334155; }
    .footer { margin-top: 20px; font-size: 11px; color: #64748b; text-align: center; line-height: 1.5; }
    .footer a { color: #38bdf8; text-decoration: none; }
  </style>
</head>
<body>
  <div class="card">
    <span class="badge"><span class="pulse"></span> ورکر فعال و متصل به DC2 تلگرام (آمستردام)</span>
    <h1>سرور پروکسی تلگرام Telo (Cloudflare Worker)</h1>
    <p class="desc">
      این ورکر با معماری مدرن <code>cloudflare:sockets</code> و Durable Objects اجرا شده و ترافیک تلگرام را مستقیماً از طریق لبه‌های Anycast به دیتاسنترهای رسمی تلگرام متصل می‌نماید.
    </p>

    <div class="grid">
      <div class="box">
        <div class="box-title">هاست سرور (Host)</div>
        <div class="box-val">${host}</div>
      </div>
      <div class="box">
        <div class="box-title">پورت اتصال (Port)</div>
        <div class="box-val">443 (HTTPS/WSS)</div>
      </div>
      <div class="box" style="grid-column: span 2;">
        <div class="box-title">کلید سکرت (Secret)</div>
        <div class="box-val">${secret}</div>
      </div>
    </div>

    <a href="${tgDeepLink}" class="btn btn-primary">
      🚀 اتصال مستقیم به تلگرام (Open in Telegram)
    </a>

    <a href="${tgWebLink}" target="_blank" class="btn btn-secondary">
      🔗 باز کردن لینک تحت وب (t.me/proxy)
    </a>

    <div class="footer">
      توسعه داده شده برای اینترنت ایران (همراه اول، ایرانسل و آسیاتک)<br>
      وضعیت سلامت: <a href="/healthz">/healthz</a> | پل ارتباطی: <code>/api/session</code>
    </div>
  </div>
</body>
</html>`;

      return new Response(html, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          ...securityHeaders
        }
      });
    }

    // Camouflage 404 for all other paths
    return new Response('404 Not Found', {
      status: 404,
      headers: {
        'Content-Type': 'text/plain',
        ...securityHeaders
      }
    });
  }
};

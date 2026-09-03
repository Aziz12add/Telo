export function generateWorkerCode(options: {
  workerName: string;
  camouflageDomain: string;
  secretHex: string;
}): string {
  const { workerName, camouflageDomain, secretHex } = options;

  return `/**
 * Cloudflare Worker Telegram Proxy & Gateway
 * Auto-deployed for Iranian ISPs: Irancell, MCI (Hamrah-e Aval), Asiatech
 * Generated: ${new Date().toISOString()}
 */

import { connect } from 'cloudflare:sockets';

// Telegram Data Centers
const TELEGRAM_DCS = {
  1: { ip: '149.154.175.50', port: 443 }, // DC1 (Miami)
  2: { ip: '149.154.167.50', port: 443 }, // DC2 (Amsterdam - Primary for Iran/EU)
  3: { ip: '149.154.175.100', port: 443 }, // DC3 (Miami)
  4: { ip: '149.154.167.91', port: 443 }, // DC4 (Amsterdam)
  5: { ip: '91.108.56.165', port: 443 }   // DC5 (Singapore)
};

const DEFAULT_DC = TELEGRAM_DCS[2]; // Default to DC2 (Amsterdam) for lowest latency in Iran
const CAMOUFLAGE_DOMAIN = "${camouflageDomain || 'www.google.com'}";
const WORKER_NAME = "${workerName}";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const upgradeHeader = request.headers.get('Upgrade');

    // 1. Handle WebSocket / MTProto TCP Tunneling
    if (upgradeHeader === 'websocket') {
      return handleWebSocketRelay(request);
    }

    // 2. Telegram Bot API Reverse Proxy (/bot<token> or /file/bot<token>)
    if (url.pathname.startsWith('/bot') || url.pathname.startsWith('/file/bot')) {
      const targetUrl = 'https://api.telegram.org' + url.pathname + url.search;
      const modifiedRequest = new Request(targetUrl, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: 'follow'
      });
      return fetch(modifiedRequest);
    }

    // 3. Health check & Ping endpoint
    if (url.pathname === '/ping') {
      return new Response(JSON.stringify({ status: 'ok', timestamp: Date.now() }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // 4. Status & Diagnostic Landing Page
    return new Response(renderStatusPage(request, url), {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache'
      }
    });
  }
};

/**
 * Handle WebSocket bi-directional streaming to Telegram DC
 */
async function handleWebSocketRelay(request) {
  const webSocketPair = new WebSocketPair();
  const [clientWs, serverWs] = Object.values(webSocketPair);
  serverWs.accept();

  // Connect directly to Telegram DC2 over TCP/TLS
  try {
    const socket = connect({
      hostname: DEFAULT_DC.ip,
      port: DEFAULT_DC.port
    });

    const writer = socket.writable.getWriter();
    const reader = socket.readable.getReader();

    // Client WS -> Telegram DC
    serverWs.addEventListener('message', async (event) => {
      try {
        const data = typeof event.data === 'string' 
          ? new TextEncoder().encode(event.data) 
          : new Uint8Array(event.data);
        await writer.write(data);
      } catch (err) {
        serverWs.close(1011, 'Socket write error');
      }
    });

    // Telegram DC -> Client WS
    (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          serverWs.send(value);
        }
      } catch (err) {
        // Stream finished
      } finally {
        serverWs.close();
      }
    })();

    serverWs.addEventListener('close', () => {
      try { socket.close(); } catch (e) {}
    });

  } catch (error) {
    return new Response('Relay error: ' + error.message, { status: 502 });
  }

  return new Response(null, {
    status: 101,
    webSocket: clientWs
  });
}

/**
 * HTML Diagnostic and Status Page
 */
function renderStatusPage(request, url) {
  const clientCountry = request.headers.get('cf-ipcountry') || 'Unknown';
  const clientIp = request.headers.get('cf-connecting-ip') || 'Unknown';
  const host = request.headers.get('host') || url.host;

  return \`<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>وضعیت پروکسی کلودفلر تلگرام | \${WORKER_NAME}</title>
  <style>
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #0f172a;
      color: #f8fafc;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      padding: 16px;
    }
    .card {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 16px;
      padding: 32px;
      max-width: 540px;
      width: 100%;
      box-shadow: 0 10px 25px rgba(0,0,0,0.5);
      text-align: center;
    }
    .badge {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 999px;
      font-size: 13px;
      font-weight: 600;
      background: #059669;
      color: #ecfdf5;
      margin-bottom: 16px;
    }
    h1 { margin: 0 0 8px 0; font-size: 22px; color: #38bdf8; }
    p { color: #94a3b8; font-size: 14px; line-height: 1.6; margin: 8px 0; }
    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin: 20px 0;
      text-align: right;
    }
    .item {
      background: #0f172a;
      padding: 12px;
      border-radius: 8px;
      border: 1px solid #1e293b;
    }
    .item-label { font-size: 11px; color: #64748b; margin-bottom: 4px; }
    .item-val { font-size: 13px; font-weight: 600; color: #cbd5e1; direction: ltr; text-align: left; }
    .footer { font-size: 12px; color: #64748b; margin-top: 20px; }
  </style>
</head>
<body>
  <div class="card">
    <span class="badge">فعال و آماده اتصال (Active)</span>
    <h1>سرور پروکسی کلودفلر تلگرام</h1>
    <p>ورکر با موفقیت در لایه شبکه Anycast کلودفلر مستقر شده و بسته‌های تلگرام را به دیتاسنتر اصلی (DC2 Amsterdam) هدایت می‌کند.</p>
    
    <div class="grid">
      <div class="item">
        <div class="item-label">دامنه ورکر (Host)</div>
        <div class="item-val">\${host}</div>
      </div>
      <div class="item">
        <div class="item-label">دیتاسنتر مقصد</div>
        <div class="item-val">DC2: 149.154.167.50:443</div>
      </div>
      <div class="item">
        <div class="item-label">آی‌پی اتصال شما</div>
        <div class="item-val">\${clientIp}</div>
      </div>
      <div class="item">
        <div class="item-label">لوکیشن لبه (Edge)</div>
        <div class="item-val">\${clientCountry}</div>
      </div>
    </div>

    <div class="footer">
      بهینه‌سازی شده برای اپراتورهای ایرانسل، همراه اول و آسیاتک
    </div>
  </div>
</body>
</html>\`;
}
`;
}

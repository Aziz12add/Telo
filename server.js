import http from 'http';
import fs from 'fs';
import path from 'path';

// AI Studio default app port is 3000 (proxied by Nginx on 8080)
const PORT = 3000;

const HTML_CONTENT = `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Telo — Telegram WEB Proxy v1 Deployer</title>
  <style>
    :root {
      --bg: #090d16;
      --card-bg: #111827;
      --accent: #2563eb;
      --accent-hover: #1d4ed8;
      --text: #f3f4f6;
      --text-muted: #9ca3af;
      --border: #1f2937;
      --success: #10b981;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 16px;
      max-width: 600px;
      width: 100%;
      padding: 32px;
      box-shadow: 0 10px 25px rgba(0, 0, 0, 0.5);
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 12px;
      background: rgba(16, 185, 129, 0.1);
      color: var(--success);
      border-radius: 9999px;
      font-size: 0.85rem;
      margin-bottom: 16px;
    }
    .dot {
      width: 8px;
      height: 8px;
      background: var(--success);
      border-radius: 50%;
    }
    h1 {
      font-size: 1.6rem;
      font-weight: 700;
      margin-bottom: 8px;
      color: #ffffff;
    }
    p {
      color: var(--text-muted);
      font-size: 0.95rem;
      line-height: 1.6;
      margin-bottom: 24px;
    }
    .tree-box {
      background: #030712;
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 16px;
      font-family: monospace;
      font-size: 0.85rem;
      color: #38bdf8;
      direction: ltr;
      text-align: left;
      margin-bottom: 24px;
      line-height: 1.5;
    }
    .section-title {
      font-size: 1rem;
      font-weight: 600;
      margin-bottom: 8px;
      color: #e5e7eb;
    }
    .btn {
      display: inline-block;
      width: 100%;
      padding: 12px;
      background: var(--accent);
      color: #fff;
      text-align: center;
      border-radius: 8px;
      text-decoration: none;
      font-weight: 600;
      font-size: 0.95rem;
      transition: background 0.15s ease;
      margin-top: 8px;
    }
    .btn:hover {
      background: var(--accent-hover);
    }
    .footer {
      margin-top: 24px;
      font-size: 0.8rem;
      color: #6b7280;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">
      <span class="dot"></span> ورکر تلگرام آماده است (Cloudflare Workers Ready)
    </div>
    <h1>Telo — Telegram Official WEB Proxy v1</h1>
    <p>
      پروژه Telo ساختار تمیز، استاندارد و رسمی Telegram WEB Proxy v1 را برای Cloudflare Workers پیاده‌سازی کرده است.
    </p>

    <div class="section-title">ساختار استاندارد مخزن (Canonical Structure):</div>
    <div class="tree-box">
Telo/
├── src/
│   ├── index.ts           # Worker router & bridge auth
│   ├── WebSocketProxy.ts  # Durable Object & TCP DC relay
│   └── protocol.ts        # Official Big-Endian frame codec
├── wrangler.toml          # Cloudflare Workers configuration
├── package.json           # Dependencies & build scripts
├── tsconfig.json          # TypeScript Worker configuration
├── .gitignore             # Git ignore definitions
└── README.md              # Documentation & connection guide
    </div>

    <div class="section-title">مشخصات پروتکل:</div>
    <ul style="color: var(--text-muted); font-size: 0.875rem; line-height: 1.7; margin-bottom: 20px; padding-right: 20px;">
      <li>فریم‌های باینری بیگ‌اندین (Header 8B: type, stream_id, length)</li>
      <li>رمزنگاری و اعتبارسنجی قابلیت Bridge با الگوریتم HMAC-SHA256</li>
      <li>رله شفاف بایت‌های رمزگذاری‌شده کلاینت تلگرام (Opaque DATA)</li>
      <li>اتصال مستقیم به دیتاسنترهای تلگرام با cloudflare:sockets</li>
    </ul>

    <a href="https://t.me/webproxy" target="_blank" rel="noopener" class="btn">
      اطلاعات بیشتر درباره پروتکل در تلگرام
    </a>

    <div class="footer">
      Telo Cloudflare Workers Runtime &bull; Production Ready
    </div>
  </div>
</body>
</html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // Health checks
  if (url.pathname === '/healthz' || url.pathname === '/health' || url.pathname === '/readyz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, status: 'healthy', service: 'telo-telegram-proxy' }));
    return;
  }

  // Root or any preview path
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
  res.end(HTML_CONTENT);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Telo dev server running on port ${PORT}`);
});

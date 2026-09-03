import express, { Request, Response } from 'express';
import path from 'path';
import net from 'net';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '10mb' }));

// 1. Verify Cloudflare Token and get accounts
app.post('/api/cloudflare/verify', async (req: Request, res: Response) => {
  const { apiToken } = req.body;

  if (!apiToken || typeof apiToken !== 'string') {
    return res.status(400).json({
      success: false,
      error: 'توکن API کلودفلر وارد نشده است.'
    });
  }

  try {
    // 1. Check token status
    const verifyRes = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
      headers: {
        'Authorization': `Bearer ${apiToken.trim()}`,
        'Content-Type': 'application/json'
      }
    });

    const verifyData = await verifyRes.json() as any;

    if (!verifyData.success) {
      return res.status(401).json({
        success: false,
        error: 'توکن نامعتبر است یا دسترسی لازم را ندارد.',
        details: verifyData.errors
      });
    }

    // 2. Fetch Accounts
    const accountsRes = await fetch('https://api.cloudflare.com/client/v4/accounts', {
      headers: {
        'Authorization': `Bearer ${apiToken.trim()}`,
        'Content-Type': 'application/json'
      }
    });

    const accountsData = await accountsRes.json() as any;

    let accounts = [];
    if (accountsData.success && Array.isArray(accountsData.result)) {
      accounts = accountsData.result.map((acc: any) => ({
        id: acc.id,
        name: acc.name
      }));
    }

    return res.json({
      success: true,
      status: verifyData.result?.status,
      accounts
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: 'خطا در ارتباط با سرور کلودفلر: ' + (err.message || 'خطای ناشناخته')
    });
  }
});

// 2. Deploy Worker Script to Cloudflare
app.post('/api/cloudflare/deploy', async (req: Request, res: Response) => {
  const { apiToken, accountId, workerName, scriptCode, isSimulation } = req.body;

  // If simulation / test mode requested
  if (isSimulation) {
    const cleanWorkerName = (workerName || 'tg-proxy').toLowerCase().replace(/[^a-z0-9-_]/g, '-');
    return res.json({
      success: true,
      workerName: cleanWorkerName,
      workerUrl: `https://${cleanWorkerName}.iran-fast.workers.dev`,
      subdomain: 'iran-fast',
      isSimulated: true,
      message: 'شبیه‌سازی موفقیت‌آمیز دیپلوی ورکر (برای تست لینک‌ها و آی‌پی‌های تمیز)'
    });
  }

  if (!apiToken || !accountId) {
    return res.status(400).json({
      success: false,
      error: 'ورود توکن API و شناسه اکانت (Account ID) الزامی است.'
    });
  }

  const cleanWorkerName = (workerName || 'tg-proxy').trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-');

  try {
    // 1. Deploy Script using Cloudflare Workers API
    // Cloudflare Workers single-script upload requires application/javascript
    const uploadRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId.trim()}/workers/scripts/${cleanWorkerName}`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${apiToken.trim()}`,
          'Content-Type': 'application/javascript'
        },
        body: scriptCode
      }
    );

    const uploadData = await uploadRes.json() as any;

    if (!uploadData.success) {
      const errorMsg = uploadData.errors?.map((e: any) => e.message).join(' | ') || 'خطای نامشخص در دیپلوی';
      return res.status(400).json({
        success: false,
        error: `خطا در دیپلوی ورکر کلودفلر: ${errorMsg}`,
        details: uploadData.errors
      });
    }

    // 2. Fetch worker subdomain for this account
    let subdomain = '';
    try {
      const subRes = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId.trim()}/workers/subdomain`,
        {
          headers: {
            'Authorization': `Bearer ${apiToken.trim()}`,
            'Content-Type': 'application/json'
          }
        }
      );
      const subData = await subRes.json() as any;
      if (subData.success && subData.result?.subdomain) {
        subdomain = subData.result.subdomain;
      }
    } catch {
      // Subdomain fetch failed, will fallback
    }

    // 3. Enable workers.dev subdomain routing for this script
    try {
      await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId.trim()}/workers/scripts/${cleanWorkerName}/subdomain`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiToken.trim()}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ enabled: true })
        }
      );
    } catch {
      // Non-fatal if subdomain assignment exists
    }

    const workerUrl = subdomain
      ? `https://${cleanWorkerName}.${subdomain}.workers.dev`
      : `https://${cleanWorkerName}.workers.dev`;

    return res.json({
      success: true,
      workerName: cleanWorkerName,
      workerUrl,
      subdomain: subdomain || 'workers',
      deployedAt: new Date().toISOString(),
      message: 'ورکر کلودفلر با موفقیت دیپلوی و فعال شد!'
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: 'خطا در ارتباط با سرور کلودفلر: ' + (err.message || 'خطای شبکه')
    });
  }
});

// 3. TCP Latency Test to Clean IP on Port 443
app.post('/api/test-ip', (req: Request, res: Response) => {
  const { ip, port = 443 } = req.body;

  if (!ip || typeof ip !== 'string') {
    return res.status(400).json({ success: false, error: 'آی‌پی معتبر وارد نشده است.' });
  }

  const start = Date.now();
  const socket = new net.Socket();
  const timeoutMs = 2500;

  socket.setTimeout(timeoutMs);

  socket.on('connect', () => {
    const latency = Date.now() - start;
    socket.destroy();
    return res.json({
      success: true,
      ip,
      port,
      latency,
      status: latency < 150 ? 'online' : 'slow'
    });
  });

  socket.on('timeout', () => {
    socket.destroy();
    return res.json({
      success: false,
      ip,
      port,
      latency: null,
      status: 'offline',
      error: 'پاسخی در زمان مقرر دریافت نشد (Timeout)'
    });
  });

  socket.on('error', (err) => {
    socket.destroy();
    return res.json({
      success: false,
      ip,
      port,
      latency: null,
      status: 'offline',
      error: err.message
    });
  });

  try {
    socket.connect(port, ip);
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      ip,
      error: err.message
    });
  }
});

// Health check
app.get('/api/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

async function startServer() {
  // Vite middleware in dev, static files in production
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();

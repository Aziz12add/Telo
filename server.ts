import express, { Request, Response } from 'express';
import path from 'path';
import net from 'net';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';
import { generateWorkerBundle } from './src/worker-runtime/bundle.ts';

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '10mb' }));

// Simple in-memory rate limiter to avoid abuse of CF API endpoints
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
function checkRateLimit(ip: string, limit = 20, windowSec = 60): boolean {
  const now = Date.now();
  const item = rateLimitMap.get(ip);
  if (!item || now > item.resetTime) {
    rateLimitMap.set(ip, { count: 1, resetTime: now + windowSec * 1000 });
    return true;
  }
  if (item.count >= limit) return false;
  item.count++;
  return true;
}

// 1. Verify Cloudflare Token and list accounts
app.post('/api/cloudflare/verify', async (req: Request, res: Response) => {
  const clientIp = req.ip || '127.0.0.1';
  if (!checkRateLimit(clientIp, 30, 60)) {
    return res.status(429).json({ success: false, error: 'تعداد درخواست‌ها بیش از حد مجاز است. لطفاً ۱ دقیقه بعد تلاش کنید.' });
  }

  const { apiToken } = req.body;
  if (!apiToken || typeof apiToken !== 'string') {
    return res.status(400).json({ success: false, error: 'توکن API کلودفلر وارد نشده است.' });
  }

  try {
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
        error: 'توکن نامعتبر است یا منقضی شده است.',
        details: verifyData.errors
      });
    }

    // Fetch Accounts
    const accountsRes = await fetch('https://api.cloudflare.com/client/v4/accounts', {
      headers: {
        'Authorization': `Bearer ${apiToken.trim()}`,
        'Content-Type': 'application/json'
      }
    });

    const accountsData = await accountsRes.json() as any;
    let accounts: { id: string; name: string }[] = [];
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
      error: 'خطا در ارتباط با سرور کلودفلر: ' + (err.message || 'خطای شبکه')
    });
  }
});

// 2. Deploy Real Modular Worker with Durable Objects via multipart/form-data
app.post('/api/cloudflare/deploy', async (req: Request, res: Response) => {
  const clientIp = req.ip || '127.0.0.1';
  if (!checkRateLimit(clientIp, 15, 60)) {
    return res.status(429).json({ success: false, error: 'درخواست‌های دیپلوی مکرر محدود شده‌اند. لطفاً کمی صبر کنید.' });
  }

  const { apiToken, accountId, workerName, proxySecret, customHostname, isSimulation } = req.body;

  const cleanWorkerName = (workerName || 'telo-proxy').trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-');
  const cleanSecret = (proxySecret || '').trim() || 'e0e1e2e3e4e5e6e7e8e9eaebecedeeef';

  if (isSimulation) {
    const demoSubdomain = 'telo-iran';
    const demoUrl = `https://${cleanWorkerName}.${demoSubdomain}.workers.dev`;
    return res.json({
      success: true,
      workerName: cleanWorkerName,
      workerUrl: demoUrl,
      subdomain: demoSubdomain,
      isSimulated: true,
      secret: cleanSecret,
      deployedAt: new Date().toISOString(),
      message: 'شبیه‌سازی موفقیت‌آمیز ورکر با معماری Durable Objects'
    });
  }

  if (!apiToken || !accountId) {
    return res.status(400).json({
      success: false,
      error: 'ورود توکن API و شناسه اکانت (Account ID) الزامی است.'
    });
  }

  try {
    // 1. Generate full bundle: metadata + modules
    const bundle = generateWorkerBundle({
      workerName: cleanWorkerName,
      proxySecret: cleanSecret,
      customHostname: customHostname?.trim() || undefined
    });

    // 2. Build multipart/form-data using standard FormData
    const formData = new FormData();

    // Attach metadata as application/json
    const metadataBlob = new Blob([JSON.stringify(bundle.metadata)], { type: 'application/json' });
    formData.append('metadata', metadataBlob, 'metadata.json');

    // Attach all module files
    for (const [filename, content] of Object.entries(bundle.files)) {
      const fileBlob = new Blob([content], { type: 'application/javascript+module' });
      formData.append(filename, fileBlob, filename);
    }

    // 3. Upload to Cloudflare Workers API v4
    const uploadRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId.trim()}/workers/scripts/${cleanWorkerName}`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${apiToken.trim()}`
          // Fetch will automatically generate multipart/form-data boundary header!
        },
        body: formData
      }
    );

    const uploadData = await uploadRes.json() as any;

    if (!uploadData.success) {
      const errors = uploadData.errors || [];
      const errorMsg = errors.map((e: any) => `[${e.code}] ${e.message}`).join(' | ') || 'خطا در بارگذاری ماژول‌های ورکر';
      return res.status(400).json({
        success: false,
        error: `خطا در دیپلوی ورکر کلودفلر: ${errorMsg}`,
        details: uploadData.errors
      });
    }

    // 4. Ensure or fetch worker subdomain
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
      // Subdomain read non-fatal
    }

    // 5. Enable workers.dev subdomain routing with retry on error 10063
    let enableSuccess = false;
    let attempts = 0;
    while (attempts < 3 && !enableSuccess) {
      attempts++;
      try {
        const enableRes = await fetch(
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
        const enableData = await enableRes.json() as any;
        if (enableData.success) {
          enableSuccess = true;
          break;
        } else {
          // If error 10063 (subdomain initializing), wait 2 seconds and retry
          const has10063 = enableData.errors?.some((e: any) => e.code === 10063);
          if (has10063 && attempts < 3) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
        }
      } catch {
        break;
      }
    }

    const workerUrl = subdomain
      ? `https://${cleanWorkerName}.${subdomain}.workers.dev`
      : `https://${cleanWorkerName}.workers.dev`;

    return res.json({
      success: true,
      workerName: cleanWorkerName,
      workerUrl,
      subdomain: subdomain || 'workers.dev',
      secret: cleanSecret,
      deployedAt: new Date().toISOString(),
      message: 'ورکر با معماری کامل ماژولار و Durable Objects در کلودفلر با موفقیت مستقر شد!'
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: 'خطا در سرور دیپلوی: ' + (err.message || 'خطای شبکه')
    });
  }
});

// 3. TCP Latency Test to Clean IP on Port 443
app.post('/api/test-ip', (req: Request, res: Response) => {
  const { ip, port = 443 } = req.body;

  if (!ip || typeof ip !== 'string') {
    return res.status(400).json({ success: false, error: 'آی‌پی نامعتبر است.' });
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
      error: 'تایم‌اوت در اتصال به آی‌پی'
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

// 4. List deployed workers
app.post('/api/cloudflare/workers/list', async (req: Request, res: Response) => {
  const { apiToken, accountId } = req.body;
  if (!apiToken || !accountId) return res.status(400).json({ success: false, error: 'Missing credentials' });

  try {
    const listRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId.trim()}/workers/scripts`,
      {
        headers: {
          'Authorization': `Bearer ${apiToken.trim()}`,
          'Content-Type': 'application/json'
        }
      }
    );
    const listData = await listRes.json() as any;
    if (!listData.success) {
      return res.status(400).json({ success: false, error: 'Failed to fetch workers', details: listData.errors });
    }

    return res.json({
      success: true,
      scripts: (listData.result || []).map((s: any) => ({
        id: s.id,
        created_on: s.created_on,
        modified_on: s.modified_on
      }))
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Delete worker
app.post('/api/cloudflare/workers/delete', async (req: Request, res: Response) => {
  const { apiToken, accountId, workerName } = req.body;
  if (!apiToken || !accountId || !workerName) return res.status(400).json({ success: false, error: 'Missing parameters' });

  try {
    const delRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId.trim()}/workers/scripts/${workerName.trim()}`,
      {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${apiToken.trim()}`,
          'Content-Type': 'application/json'
        }
      }
    );
    const delData = await delRes.json() as any;
    return res.json({
      success: delData.success,
      message: delData.success ? `ورکر ${workerName} حذف شد.` : 'خطا در حذف ورکر',
      details: delData.errors
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'telo-deployer-backend', timestamp: Date.now() });
});

async function startServer() {
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

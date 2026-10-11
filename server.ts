import express, { Request, Response } from 'express';
import path from 'path';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';
import { generateWebProxyBundle } from './src/worker-runtime/bundle.ts';
import { parseSecret } from './protocol.js';

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '10mb' }));

// 1. Verify Cloudflare Token and list accounts
app.post('/api/cloudflare/verify', async (req: Request, res: Response) => {
  const { apiToken } = req.body;
  if (!apiToken || typeof apiToken !== 'string') {
    return res.status(400).json({ success: false, error: 'API token is required.' });
  }

  try {
    const verifyRes = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
      headers: {
        Authorization: `Bearer ${apiToken.trim()}`,
        'Content-Type': 'application/json',
      },
    });

    const verifyData = (await verifyRes.json()) as any;

    if (!verifyData.success) {
      return res.status(401).json({
        success: false,
        error: 'Invalid or expired Cloudflare API token.',
        details: verifyData.errors,
      });
    }

    const accountsRes = await fetch('https://api.cloudflare.com/client/v4/accounts', {
      headers: {
        Authorization: `Bearer ${apiToken.trim()}`,
        'Content-Type': 'application/json',
      },
    });

    const accountsData = (await accountsRes.json()) as any;
    let accounts: { id: string; name: string }[] = [];
    if (accountsData.success && Array.isArray(accountsData.result)) {
      accounts = accountsData.result.map((acc: any) => ({
        id: acc.id,
        name: acc.name,
      }));
    }

    return res.json({
      success: true,
      accounts,
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: 'Failed to verify Cloudflare token: ' + (err.message || 'Network error'),
    });
  }
});

// 2. Deploy Telegram Web Proxy v1 Worker via multipart/form-data
app.post('/api/cloudflare/deploy', async (req: Request, res: Response) => {
  const { apiToken, accountId, workerName, proxySecret, isSimulation } = req.body;

  const cleanWorkerName = (workerName || 'telo-webproxy')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-');

  let cleanSecret = (proxySecret || '').trim().toLowerCase();
  try {
    // Validate secret format
    parseSecret(cleanSecret);
  } catch {
    cleanSecret = '000102030405060708090a0b0c0d0e0f';
  }

  if (isSimulation) {
    const hostname = `${cleanWorkerName}.telo-preview.workers.dev`;
    return res.json({
      success: true,
      hostname,
      secret: cleanSecret,
      tmeLink: `https://t.me/webproxy?server=${encodeURIComponent(hostname)}&secret=${encodeURIComponent(cleanSecret)}`,
      tgLink: `tg://webproxy?server=${encodeURIComponent(hostname)}&secret=${encodeURIComponent(cleanSecret)}`,
    });
  }

  if (!apiToken || !accountId) {
    return res.status(400).json({
      success: false,
      error: 'Cloudflare API token and Account ID are required.',
    });
  }

  try {
    // 1. Generate full bundle (metadata.json, index.js, session.js, protocol.js)
    const bundle = generateWebProxyBundle({
      workerName: cleanWorkerName,
      proxySecret: cleanSecret,
    });

    // 2. Prepare standard multipart FormData upload
    const formData = new FormData();

    const metadataBlob = new Blob([JSON.stringify(bundle.metadata)], { type: 'application/json' });
    formData.append('metadata', metadataBlob, 'metadata.json');

    for (const [filename, content] of Object.entries(bundle.files)) {
      const fileBlob = new Blob([content], { type: 'application/javascript+module' });
      formData.append(filename, fileBlob, filename);
    }

    // 3. Upload to Cloudflare Workers v4
    const uploadRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId.trim()}/workers/scripts/${cleanWorkerName}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${apiToken.trim()}`,
        },
        body: formData,
      }
    );

    const uploadData = (await uploadRes.json()) as any;

    if (!uploadData.success) {
      const errors = uploadData.errors || [];
      const errorMsg =
        errors.map((e: any) => `[${e.code}] ${e.message}`).join(' | ') || 'Upload failed.';
      return res.status(400).json({
        success: false,
        error: `Cloudflare Workers upload error: ${errorMsg}`,
      });
    }

    // 4. Resolve account workers.dev subdomain
    let subdomain = '';
    try {
      const subRes = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId.trim()}/workers/subdomain`,
        {
          headers: {
            Authorization: `Bearer ${apiToken.trim()}`,
            'Content-Type': 'application/json',
          },
        }
      );
      const subData = (await subRes.json()) as any;
      if (subData.success && subData.result?.subdomain) {
        subdomain = subData.result.subdomain;
      }
    } catch {
      // Non-fatal
    }

    // 5. Enable workers.dev subdomain routing with retry on error 10063
    let enableSuccess = false;
    let attempts = 0;
    while (attempts < 4 && !enableSuccess) {
      attempts++;
      try {
        const enableRes = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${accountId.trim()}/workers/scripts/${cleanWorkerName}/subdomain`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiToken.trim()}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ enabled: true }),
          }
        );
        const enableData = (await enableRes.json()) as any;
        if (enableData.success) {
          enableSuccess = true;
          break;
        } else {
          const has10063 = enableData.errors?.some((e: any) => e.code === 10063);
          if (has10063 && attempts < 4) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
        }
      } catch {
        break;
      }
    }

    const hostname = subdomain
      ? `${cleanWorkerName}.${subdomain}.workers.dev`
      : `${cleanWorkerName}.workers.dev`;

    const tmeLink = `https://t.me/webproxy?server=${encodeURIComponent(hostname)}&secret=${encodeURIComponent(cleanSecret)}`;
    const tgLink = `tg://webproxy?server=${encodeURIComponent(hostname)}&secret=${encodeURIComponent(cleanSecret)}`;

    return res.json({
      success: true,
      hostname,
      secret: cleanSecret,
      tmeLink,
      tgLink,
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: 'Deploy failure: ' + (err.message || 'Internal error'),
    });
  }
});

app.get('/api/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'telo-webproxy-deployer' });
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

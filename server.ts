import express, { Request, Response } from 'express';
import path from 'path';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';
import { generateWebProxyBundle } from './src/worker-runtime/bundle.ts';

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '2mb' }));

function parseSecretHex(secretHex: string): void {
  let s = String(secretHex || '').trim().toLowerCase();
  if (s.startsWith('dd')) s = s.slice(2);
  if (s.length !== 32 || !/^[0-9a-f]{32}$/.test(s)) {
    throw new Error('Secret must be 32 hex chars (or dd + 32 hex)');
  }
}

app.post('/api/cloudflare/verify', async (req: Request, res: Response) => {
  const { apiToken } = req.body;
  if (!apiToken || typeof apiToken !== 'string') {
    return res.status(400).json({ success: false, error: 'API token is required.' });
  }
  try {
    const verifyRes = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
      headers: { Authorization: `Bearer ${apiToken.trim()}`, 'Content-Type': 'application/json' },
    });
    const verifyData = (await verifyRes.json()) as any;
    if (!verifyData.success) {
      return res.status(401).json({ success: false, error: 'Invalid Cloudflare API token.', details: verifyData.errors });
    }
    const accountsRes = await fetch('https://api.cloudflare.com/client/v4/accounts', {
      headers: { Authorization: `Bearer ${apiToken.trim()}`, 'Content-Type': 'application/json' },
    });
    const accountsData = (await accountsRes.json()) as any;
    const accounts =
      accountsData.success && Array.isArray(accountsData.result)
        ? accountsData.result.map((acc: any) => ({ id: acc.id, name: acc.name }))
        : [];
    return res.json({ success: true, accounts });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: 'Verify failed: ' + (err.message || 'network') });
  }
});

app.post('/api/cloudflare/deploy', async (req: Request, res: Response) => {
  const { apiToken, accountId, workerName, proxySecret, isSimulation } = req.body;

  const cleanWorkerName = String(workerName || 'telo-webproxy')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-');

  let cleanSecret = String(proxySecret || '').trim().toLowerCase();
  try {
    parseSecretHex(cleanSecret);
  } catch {
    return res.status(400).json({
      success: false,
      error: 'Invalid proxySecret: need 32 hex chars (optional dd prefix).',
    });
  }

  if (isSimulation) {
    const hostname = `${cleanWorkerName}.telo-preview.workers.dev`;
    return res.json({
      success: true,
      hostname,
      secret: cleanSecret,
      tmeLink: `https://t.me/webproxy?server=\( {encodeURIComponent(hostname)}&secret= \){encodeURIComponent(cleanSecret)}`,
      tgLink: `tg://webproxy?server=\( {encodeURIComponent(hostname)}&secret= \){encodeURIComponent(cleanSecret)}`,
    });
  }

  if (!apiToken || !accountId) {
    return res.status(400).json({ success: false, error: 'apiToken and accountId are required.' });
  }

  try {
    const bundle = generateWebProxyBundle({
      workerName: cleanWorkerName,
      proxySecret: cleanSecret,
      isFirstDeploy: true,
    });

    const formData = new FormData();
    formData.append(
      'metadata',
      new Blob([JSON.stringify(bundle.metadata)], { type: 'application/json' }),
      'metadata.json'
    );
    for (const [filename, content] of Object.entries(bundle.files)) {
      formData.append(filename, new Blob([content], { type: 'application/javascript+module' }), filename);
    }

    const uploadRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/\( {accountId.trim()}/workers/scripts/ \){cleanWorkerName}`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${apiToken.trim()}` },
        body: formData,
      }
    );
    const uploadData = (await uploadRes.json()) as any;
    if (!uploadData.success) {
      const errorMsg =
        (uploadData.errors || []).map((e: any) => `[${e.code}] ${e.message}`).join(' | ') || 'Upload failed';
      return res.status(400).json({ success: false, error: `Cloudflare upload: ${errorMsg}` });
    }

    let subdomain = '';
    try {
      const subRes = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId.trim()}/workers/subdomain`,
        { headers: { Authorization: `Bearer ${apiToken.trim()}` } }
      );
      const subData = (await subRes.json()) as any;
      if (subData.success && subData.result?.subdomain) subdomain = subData.result.subdomain;
    } catch {}

    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const enableRes = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/\( {accountId.trim()}/workers/scripts/ \){cleanWorkerName}/subdomain`,
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
        if (enableData.success) break;
        const has10063 = enableData.errors?.some((e: any) => e.code === 10063);
        if (has10063 && attempt < 3) await new Promise((r) => setTimeout(r, 2000));
      } catch {
        break;
      }
    }

    const hostname = subdomain
      ? `\( {cleanWorkerName}. \){subdomain}.workers.dev`
      : `${cleanWorkerName}.workers.dev`;

    return res.json({
      success: true,
      hostname,
      secret: cleanSecret,
      tmeLink: `https://t.me/webproxy?server=\( {encodeURIComponent(hostname)}&secret= \){encodeURIComponent(cleanSecret)}`,
      tgLink: `tg://webproxy?server=\( {encodeURIComponent(hostname)}&secret= \){encodeURIComponent(cleanSecret)}`,
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: 'Deploy failure: ' + (err.message || 'internal') });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'telo-webproxy-deployer' });
});

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => res.sendFile(path.join(distPath, 'index.html')));
  }
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();

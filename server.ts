import fs from 'fs';
import express, { Request, Response } from 'express';
import path from 'path';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';
import { generateWebProxyBundle } from './src/worker-runtime/bundle';

dotenv.config();

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const isProduction = process.env.NODE_ENV === 'production';

app.use(express.json({ limit: '10mb' }));

// Health check endpoint
app.get('/healthz', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'telo-fullstack-deployer', timestamp: Date.now() });
});

// Cloudflare API Token verification endpoint
app.post('/api/cloudflare/verify', async (req: Request, res: Response) => {
  const { apiToken } = req.body;
  if (!apiToken || typeof apiToken !== 'string') {
    return res.status(400).json({ success: false, error: 'API token is required.' });
  }

  try {
    const cfRes = await fetch('https://api.cloudflare.com/client/v4/accounts', {
      headers: {
        Authorization: `Bearer ${apiToken.trim()}`,
        'Content-Type': 'application/json',
      },
    });

    const data = await cfRes.json() as any;

    if (!cfRes.ok || !data.success) {
      const errMsg = data.errors?.[0]?.message || 'Invalid Cloudflare API token or missing permissions.';
      return res.status(400).json({ success: false, error: errMsg });
    }

    const accounts = (data.result || []).map((acc: any) => ({
      id: acc.id,
      name: acc.name,
    }));

    return res.json({ success: true, accounts });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: `Failed to contact Cloudflare: ${err.message || 'Network error'}`,
    });
  }
});

// Cloudflare Worker Deployment endpoint (multipart ES modules + Durable Object)
app.post('/api/cloudflare/deploy', async (req: Request, res: Response) => {
  const { apiToken, accountId, workerName, proxySecret, isSimulation } = req.body;

  if (!workerName || !proxySecret) {
    return res.status(400).json({ success: false, error: 'Missing workerName or proxySecret.' });
  }

  // Simulation mode for quick testing
  if (isSimulation) {
    const simHost = `${workerName.toLowerCase()}.workers.dev`;
    return res.json({
      success: true,
      hostname: simHost,
      secret: proxySecret,
      tmeLink: `https://t.me/webproxy?server=${encodeURIComponent(simHost)}&secret=${encodeURIComponent(proxySecret)}`,
      tgLink: `tg://webproxy?server=${encodeURIComponent(simHost)}&secret=${encodeURIComponent(proxySecret)}`,
    });
  }

  if (!apiToken || !accountId) {
    return res.status(400).json({ success: false, error: 'apiToken and accountId are required for real deployment.' });
  }

  try {
    // 1. Fetch account workers subdomain
    const subRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`, {
      headers: {
        Authorization: `Bearer ${apiToken.trim()}`,
        'Content-Type': 'application/json',
      },
    });
    const subData = await subRes.json() as any;
    const rawSub = subData.result?.subdomain || accountId.substring(0, 8);
    const subdomain = String(rawSub).replace(/\.workers\.dev$/i, '');
    const hostname = `${workerName.toLowerCase()}.${subdomain}.workers.dev`;

    // 2. Generate multi-module bundle
    const bundle = generateWebProxyBundle({
      workerName: workerName.trim(),
      proxySecret: proxySecret.trim(),
    });

    // 3. Build multipart/form-data payload
    const formData = new FormData();
    formData.append(
      'metadata',
      new Blob([JSON.stringify(bundle.metadata)], { type: 'application/json' }),
      'metadata.json'
    );

    for (const [filename, content] of Object.entries(bundle.files)) {
      formData.append(
        filename,
        new Blob([content], { type: 'application/javascript+module' }),
        filename
      );
    }

    // 4. Upload script via PUT with retry on Cloudflare error 10063
    let uploadRes: any = null;
    let uploadData: any = null;
    let attempts = 0;

    while (attempts < 3) {
      attempts++;
      uploadRes = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${encodeURIComponent(workerName.trim())}`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${apiToken.trim()}`,
          },
          body: formData,
        }
      );

      uploadData = await uploadRes.json() as any;

      if (uploadData.success) {
        break;
      }

      // Check for code 10063 (temporary rate limit or state lock)
      const is10063 = uploadData.errors?.some((e: any) => e.code === 10063);
      if (is10063 && attempts < 3) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        continue;
      }
      break;
    }

    if (!uploadData?.success) {
      const errMsg = uploadData?.errors?.[0]?.message || 'Failed to upload script to Cloudflare.';
      return res.status(400).json({ success: false, error: errMsg });
    }

    // 5. Enable workers.dev subdomain routing
    await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${encodeURIComponent(workerName.trim())}/subdomain`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken.trim()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ enabled: true }),
      }
    );

    const tmeLink = `https://t.me/webproxy?server=${encodeURIComponent(hostname)}&secret=${encodeURIComponent(proxySecret.trim())}`;
    const tgLink = `tg://webproxy?server=${encodeURIComponent(hostname)}&secret=${encodeURIComponent(proxySecret.trim())}`;

    return res.json({
      success: true,
      hostname,
      secret: proxySecret.trim(),
      tmeLink,
      tgLink,
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: `Deployment error: ${err.message || 'Unknown network error'}`,
    });
  }
});


// Endpoint to inspect generated Worker bundle and modules
app.get("/api/worker/bundle", (req: Request, res: Response) => {
  const workerName = String(req.query.workerName || "telo-webproxy");
  const proxySecret = String(req.query.proxySecret || "000102030405060708090a0b0c0d0e0f");

  try {
    const bundle = generateWebProxyBundle({
      workerName: workerName.trim(),
      proxySecret: proxySecret.trim(),
    });

    const root = process.cwd();
    const readSafe = (filePath: string) => {
      try {
        return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : "";
      } catch {
        return "";
      }
    };

    const sessionCode = readSafe(path.join(root, "session.js")) || readSafe(path.join(root, "src", "worker", "session.ts"));
    const protocolCode = readSafe(path.join(root, "protocol.js")) || readSafe(path.join(root, "src", "worker", "protocol.ts"));

    return res.json({
      success: true,
      metadata: bundle.metadata,
      files: {
        "index.js": bundle.files["index.js"] || "",
        "session.js": sessionCode,
        "protocol.js": protocolCode,
        "metadata.json": JSON.stringify(bundle.metadata, null, 2),
      },
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: err.message || "Failed to generate bundle preview",
    });
  }
});

// Setup Vite middleware or static serving
async function startServer() {
  if (!isProduction) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

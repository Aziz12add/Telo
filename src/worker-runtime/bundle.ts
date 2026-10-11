import fs from 'fs';
import path from 'path';

export interface WorkerBundleConfig {
  workerName: string;
  proxySecret: string;
}

export interface WorkerBundle {
  metadata: any;
  files: Record<string, string>;
}

export function generateWebProxyBundle(config: WorkerBundleConfig): WorkerBundle {
  const { proxySecret } = config;

  // Cloudflare Workers multipart metadata with Durable Object and PROXY_SECRET
  const metadata = {
    main_module: 'index.js',
    compatibility_date: '2024-11-11',
    compatibility_flags: ['nodejs_compat'],
    bindings: [
      {
        type: 'secret_text',
        name: 'PROXY_SECRET',
        text: proxySecret,
      },
      {
        type: 'durable_object_namespace',
        name: 'SESSIONS',
        class_name: 'ProxySessionDO',
      },
    ],
    migrations: {
      new_sqlite_classes: ['ProxySessionDO'],
    },
  };

  // Read the canonical modules directly from the root repository
  const protocolCode = fs.readFileSync(path.join(process.cwd(), 'protocol.js'), 'utf-8');
  const sessionCode = fs.readFileSync(path.join(process.cwd(), 'session.js'), 'utf-8');
  const indexCode = fs.readFileSync(path.join(process.cwd(), 'index.js'), 'utf-8');

  return {
    metadata,
    files: {
      'index.js': indexCode,
      'session.js': sessionCode,
      'protocol.js': protocolCode,
    },
  };
}

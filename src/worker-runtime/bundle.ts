import fs from 'fs';
import path from 'path';

export interface WorkerBundleConfig {
  workerName: string;
  proxySecret: string;
  /** Only first deploy should create the DO class */
  isFirstDeploy?: boolean;
}

export interface WorkerBundle {
  metadata: any;
  files: Record<string, string>;
}

export function generateWebProxyBundle(config: WorkerBundleConfig): WorkerBundle {
  const { proxySecret, isFirstDeploy = true } = config;

  const metadata: any = {
    main_module: 'index.js',
    compatibility_date: '2024-11-11',
    compatibility_flags: ['nodejs_compat'],
    bindings: [
      { type: 'secret_text', name: 'PROXY_SECRET', text: proxySecret },
      {
        type: 'durable_object_namespace',
        name: 'SESSIONS',
        class_name: 'ProxySessionDO',
      },
    ],
  };

  // Avoid repeating new_sqlite_classes on every upload when possible
  if (isFirstDeploy) {
    metadata.migrations = { new_sqlite_classes: ['ProxySessionDO'] };
  }

  const root = process.cwd();
  return {
    metadata,
    files: {
      'index.js': fs.readFileSync(path.join(root, 'index.js'), 'utf-8'),
      'session.js': fs.readFileSync(path.join(root, 'session.js'), 'utf-8'),
      'protocol.js': fs.readFileSync(path.join(root, 'protocol.js'), 'utf-8'),
    },
  };
}

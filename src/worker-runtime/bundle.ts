import fs from 'fs';
import path from 'path';
import * as esbuild from 'esbuild';

export interface WorkerBundleConfig {
  workerName: string;
  proxySecret: string;
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

  if (isFirstDeploy) {
    metadata.migrations = { new_sqlite_classes: ['ProxySessionDO'] };
  }

  const root = process.cwd();
  const workerEntry = path.join(root, 'src', 'worker', 'index.ts');

  let bundledCode = '';
  try {
    const result = esbuild.buildSync({
      entryPoints: [workerEntry],
      bundle: true,
      format: 'esm',
      target: 'es2022',
      external: ['cloudflare:sockets'],
      write: false,
    });
    bundledCode = result.outputFiles[0].text;
  } catch (err) {
    const rootIndex = path.join(root, 'index.js');
    if (fs.existsSync(rootIndex)) {
      bundledCode = fs.readFileSync(rootIndex, 'utf-8');
    } else {
      throw new Error(`Failed to bundle worker from ${workerEntry}: ${err}`);
    }
  }

  return {
    metadata,
    files: {
      'index.js': bundledCode,
    },
  };
}

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Header } from './components/Header';
import { CloudflareDeployer } from './components/CloudflareDeployer';
import { WebProxyResultPanel } from './components/WebProxyResultPanel';
import { HelpGuideModal } from './components/HelpGuideModal';
import { WorkerCodeModal } from './components/WorkerCodeModal';
import { CloudflareAccount, WebProxyDeployResult } from './types';
import { ShieldCheck, Zap } from 'lucide-react';

function generateRandom32Hex(): string {
  if (typeof window !== 'undefined' && window.crypto && window.crypto.getRandomValues) {
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  return (
    Math.random().toString(16).substring(2, 18) +
    Math.random().toString(16).substring(2, 18)
  );
}

export default function App() {
  const [apiToken, setApiToken] = useState('');
  const [accountId, setAccountId] = useState('');
  const [accounts, setAccounts] = useState<CloudflareAccount[]>([]);
  const [workerName, setWorkerName] = useState('telo-webproxy');
  const [proxySecret, setProxySecret] = useState(generateRandom32Hex);

  const [isVerifying, setIsVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  const [isDeploying, setIsDeploying] = useState(false);
  const [deployError, setDeployError] = useState<string | null>(null);

  const [deployResult, setDeployResult] = useState<WebProxyDeployResult | null>(null);

  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [isCodeOpen, setIsCodeOpen] = useState(false);

  const handleVerifyToken = async () => {
    if (!apiToken.trim()) return;
    setIsVerifying(true);
    setVerifyError(null);

    try {
      const res = await fetch('/api/cloudflare/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiToken: apiToken.trim() }),
      });
      const data: any = await res.json();
      if (data.success) {
        setAccounts(data.accounts || []);
        if (data.accounts?.length > 0 && !accountId) {
          setAccountId(data.accounts[0].id);
        }
      } else {
        setVerifyError(data.error || 'Invalid API token.');
      }
    } catch {
      setVerifyError('Failed to communicate with verification server.');
    } finally {
      setIsVerifying(false);
    }
  };

  const handleDeploy = async (isSimulation: boolean = false) => {
    setIsDeploying(true);
    setDeployError(null);

    try {
      const res = await fetch('/api/cloudflare/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiToken: apiToken.trim(),
          accountId: accountId.trim(),
          workerName: workerName.trim(),
          proxySecret: proxySecret.trim(),
          isSimulation,
        }),
      });

      const data: any = await res.json();
      if (data.success) {
        setDeployResult({
          hostname: data.hostname,
          secret: data.secret,
          tmeLink: data.tmeLink,
          tgLink: data.tgLink,
        });
      } else {
        setDeployError(data.error || 'Deployment failed.');
      }
    } catch (err: any) {
      setDeployError(err.message || 'Deployment network failure.');
    } finally {
      setIsDeploying(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      <Header
        onOpenHelp={() => setIsHelpOpen(true)}
        onOpenCode={() => setIsCodeOpen(true)}
        hostname={deployResult?.hostname || null}
      />

      <main className="flex-1 max-w-4xl w-full mx-auto px-4 py-8 space-y-6">
        {/* Info Banner */}
        <div className="bg-gradient-to-r from-sky-950/40 via-indigo-950/30 to-slate-900/50 border border-sky-800/40 rounded-2xl p-4 sm:p-5 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-sky-500/20 text-sky-400 flex items-center justify-center shrink-0">
              <Zap className="w-5 h-5" />
            </div>
            <div>
              <div className="text-xs sm:text-sm font-semibold text-white flex items-center gap-2">
                <span>Telegram Official WEB Proxy v1 Architecture</span>
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-950 text-emerald-300 border border-emerald-800/60 font-mono">
                  cloudflare:sockets TCP + DO
                </span>
              </div>
              <p className="text-[11px] sm:text-xs text-slate-400 mt-0.5">
                Connects directly to official Telegram data centers over port 443 with Big-Endian binary frames and Durable Objects.
              </p>
            </div>
          </div>
        </div>

        {/* Deployer Panel */}
        <CloudflareDeployer
          apiToken={apiToken}
          setApiToken={setApiToken}
          accountId={accountId}
          setAccountId={setAccountId}
          workerName={workerName}
          setWorkerName={setWorkerName}
          proxySecret={proxySecret}
          setProxySecret={setProxySecret}
          generateNewSecret={() => setProxySecret(generateRandom32Hex())}
          onDeploy={handleDeploy}
          isDeploying={isDeploying}
          deployError={deployError}
          accounts={accounts}
          isVerifying={isVerifying}
          verifyError={verifyError}
          onVerifyToken={handleVerifyToken}
        />

        {/* Result Panel (shows only hostname, secret, and webproxy links) */}
        {deployResult && (
          <WebProxyResultPanel
            hostname={deployResult.hostname}
            secret={deployResult.secret}
            tmeLink={deployResult.tmeLink}
            tgLink={deployResult.tgLink}
          />
        )}
      </main>

      <footer className="border-t border-slate-900 bg-slate-950 py-6 text-center text-xs text-slate-500">
        <div className="max-w-4xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-2">
          <div>Telo &bull; Official Telegram WEB Proxy v1 on Cloudflare Workers</div>
          <div className="text-slate-400 font-mono text-[11px]">
            t.me/webproxy &bull; tg://webproxy
          </div>
        </div>
      </footer>

      <HelpGuideModal isOpen={isHelpOpen} onClose={() => setIsHelpOpen(false)} />
      <WorkerCodeModal
        isOpen={isCodeOpen}
        onClose={() => setIsCodeOpen(false)}
        workerName={workerName}
        proxySecret={proxySecret}
      />
    </div>
  );
}

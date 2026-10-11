/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { WebProxyResultPanel } from './components/WebProxyResultPanel';
import { 
  Cloud, 
  Key, 
  User, 
  Cpu, 
  Sparkles, 
  RefreshCw, 
  Eye, 
  EyeOff, 
  Layers, 
  AlertTriangle 
} from 'lucide-react';

export default function App() {
  const [apiToken, setApiToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [accounts, setAccounts] = useState<{ id: string; name: string }[]>([]);
  const [accountId, setAccountId] = useState('');
  const [workerName, setWorkerName] = useState('telo-webproxy');
  const [proxySecret, setProxySecret] = useState('000102030405060708090a0b0c0d0e0f');

  const [isVerifying, setIsVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  const [isDeploying, setIsDeploying] = useState(false);
  const [deployError, setDeployError] = useState<string | null>(null);

  const [deployResult, setDeployResult] = useState<{
    hostname: string;
    secret: string;
    tmeLink: string;
    tgLink: string;
  } | null>(null);

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
      const data = await res.json();
      if (data.success) {
        setAccounts(data.accounts || []);
        if (data.accounts?.length > 0) {
          setAccountId(data.accounts[0].id);
        }
      } else {
        setVerifyError(data.error || 'Invalid token');
      }
    } catch {
      setVerifyError('Failed to verify token');
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

      const data = await res.json();
      if (data.success) {
        setDeployResult({
          hostname: data.hostname,
          secret: data.secret,
          tmeLink: data.tmeLink,
          tgLink: data.tgLink,
        });
      } else {
        setDeployError(data.error || 'Deployment failed');
      }
    } catch (err: any) {
      setDeployError(err.message || 'Deployment error');
    } finally {
      setIsDeploying(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      {/* Top Header */}
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur-md sticky top-0 z-40">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-sky-500/10 border border-sky-500/30 flex items-center justify-center text-sky-400">
              <Cloud className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-white tracking-tight">
                Telegram Web Proxy v1 Deployer
              </h1>
              <p className="text-xs text-slate-400">
                Cloudflare Workers &bull; Durable Objects &bull; Direct Sockets
              </p>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-4xl w-full mx-auto px-4 py-8 space-y-6">
        {/* Deployer Setup Card */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 sm:p-7 shadow-xl space-y-5">
          <h2 className="text-base font-bold text-white flex items-center gap-2">
            <span>Cloudflare Workers Deployment</span>
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* API Token */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                <Key className="w-3.5 h-3.5 text-amber-400" />
                <span>Cloudflare API Token</span>
              </label>
              <div className="relative flex items-center">
                <input
                  type={showToken ? 'text' : 'password'}
                  placeholder="Paste API token..."
                  value={apiToken}
                  onChange={(e) => setApiToken(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700/80 rounded-xl px-3 py-2 pl-20 text-xs text-white focus:outline-none focus:border-sky-500 font-mono"
                />
                <div className="absolute left-1.5 flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setShowToken(!showToken)}
                    className="p-1 rounded text-slate-400 hover:text-slate-200"
                  >
                    {showToken ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  </button>
                  <button
                    type="button"
                    onClick={handleVerifyToken}
                    disabled={isVerifying || !apiToken.trim()}
                    className="px-2 py-1 rounded text-[11px] font-medium bg-slate-800 text-sky-400 hover:bg-slate-700 disabled:opacity-50"
                  >
                    {isVerifying ? '...' : 'Verify'}
                  </button>
                </div>
              </div>
              {verifyError && (
                <p className="text-[11px] text-rose-400 mt-1">{verifyError}</p>
              )}
            </div>

            {/* Account ID */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                <User className="w-3.5 h-3.5 text-sky-400" />
                <span>Account ID</span>
              </label>
              {accounts.length > 0 ? (
                <select
                  value={accountId}
                  onChange={(e) => setAccountId(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700/80 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-sky-500 font-mono"
                >
                  {accounts.map((acc) => (
                    <option key={acc.id} value={acc.id}>
                      {acc.name} ({acc.id.slice(0, 8)}...)
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  placeholder="Cloudflare account ID..."
                  value={accountId}
                  onChange={(e) => setAccountId(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700/80 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-sky-500 font-mono"
                />
              )}
            </div>

            {/* Worker Name */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                <Cpu className="w-3.5 h-3.5 text-indigo-400" />
                <span>Worker Script Name</span>
              </label>
              <input
                type="text"
                value={workerName}
                onChange={(e) => setWorkerName(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700/80 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-sky-500 font-mono"
              />
            </div>

            {/* Proxy Secret */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5 text-emerald-400" />
                <span>Proxy Secret (32 Hex Characters)</span>
              </label>
              <input
                type="text"
                value={proxySecret}
                onChange={(e) => setProxySecret(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700/80 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-sky-500 font-mono"
              />
            </div>
          </div>

          {deployError && (
            <div className="p-3.5 rounded-xl bg-rose-950/60 border border-rose-800/80 text-xs text-rose-300 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <div>{deployError}</div>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex flex-wrap items-center gap-3 pt-2">
            <button
              onClick={() => handleDeploy(false)}
              disabled={isDeploying || !apiToken.trim() || !accountId.trim()}
              className="flex-1 min-w-[200px] flex items-center justify-center gap-2 py-3 px-5 rounded-xl font-semibold text-xs sm:text-sm bg-sky-600 hover:bg-sky-500 text-white shadow-lg shadow-sky-600/20 disabled:opacity-50 disabled:cursor-not-allowed transition"
            >
              {isDeploying ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  <span>Deploying Multipart Bundle...</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  <span>Deploy to Cloudflare Workers</span>
                </>
              )}
            </button>

            <button
              onClick={() => handleDeploy(true)}
              disabled={isDeploying}
              className="py-3 px-4 rounded-xl font-medium text-xs sm:text-sm bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition"
            >
              Quick Test (Simulation)
            </button>
          </div>
        </div>

        {/* Deployment Result Panel */}
        {deployResult && (
          <WebProxyResultPanel
            hostname={deployResult.hostname}
            secret={deployResult.secret}
            tmeLink={deployResult.tmeLink}
            tgLink={deployResult.tgLink}
          />
        )}
      </main>
    </div>
  );
}

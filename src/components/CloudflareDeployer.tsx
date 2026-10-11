import React, { useState } from 'react';
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
  AlertTriangle,
  ShieldCheck
} from 'lucide-react';
import { CloudflareAccount } from '../types';

interface CloudflareDeployerProps {
  apiToken: string;
  setApiToken: (token: string) => void;
  accountId: string;
  setAccountId: (id: string) => void;
  workerName: string;
  setWorkerName: (name: string) => void;
  proxySecret: string;
  setProxySecret: (sec: string) => void;
  generateNewSecret: () => void;
  onDeploy: (isSimulation?: boolean) => Promise<void>;
  isDeploying: boolean;
  deployError: string | null;
  accounts: CloudflareAccount[];
  isVerifying: boolean;
  verifyError: string | null;
  onVerifyToken: () => Promise<void>;
}

export const CloudflareDeployer: React.FC<CloudflareDeployerProps> = ({
  apiToken,
  setApiToken,
  accountId,
  setAccountId,
  workerName,
  setWorkerName,
  proxySecret,
  setProxySecret,
  generateNewSecret,
  onDeploy,
  isDeploying,
  deployError,
  accounts,
  isVerifying,
  verifyError,
  onVerifyToken,
}) => {
  const [showToken, setShowToken] = useState(false);

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 sm:p-7 shadow-xl space-y-6">
      {/* Title & info */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-slate-800">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-sky-500/10 border border-sky-500/30 flex items-center justify-center text-sky-400">
            <Cloud className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-base sm:text-lg font-bold text-white flex items-center gap-2">
              <span>Cloudflare Workers Deployment</span>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-indigo-950 text-indigo-300 border border-indigo-700/60 font-mono">
                Multipart ES Modules + DO
              </span>
            </h2>
            <p className="text-xs text-slate-400">
              Deploys official Telegram WEB Proxy v1 with Durable Objects and Direct TCP sockets
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5 text-xs text-emerald-400 bg-emerald-950/60 border border-emerald-800/80 px-3 py-1.5 rounded-xl font-medium">
          <ShieldCheck className="w-4 h-4" />
          <span>Zero Server Storage &bull; In-Memory Only</span>
        </div>
      </div>

      {/* Grid Inputs */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* API Token */}
        <div className="space-y-1.5">
          <label className="text-xs font-semibold text-slate-300 flex items-center justify-between">
            <span className="flex items-center gap-1.5">
              <Key className="w-3.5 h-3.5 text-amber-400" />
              <span>Cloudflare API Token</span>
            </span>
            <span className="text-[11px] text-slate-500">Workers Scripts Edit</span>
          </label>
          <div className="relative flex items-center">
            <input
              type={showToken ? 'text' : 'password'}
              placeholder="Paste Cloudflare API token..."
              value={apiToken}
              onChange={(e) => setApiToken(e.target.value)}
              className="w-full bg-slate-950 border border-slate-700/80 rounded-xl px-3.5 py-2.5 pl-24 text-xs text-white focus:outline-none focus:border-sky-500 font-mono"
            />
            <div className="absolute left-1.5 flex items-center gap-1">
              <button
                type="button"
                onClick={() => setShowToken(!showToken)}
                className="p-1 rounded text-slate-400 hover:text-slate-200 transition"
              >
                {showToken ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </button>
              <button
                type="button"
                onClick={onVerifyToken}
                disabled={isVerifying || !apiToken.trim()}
                className="px-2.5 py-1 rounded text-[11px] font-medium bg-slate-800 text-sky-400 hover:bg-slate-700 disabled:opacity-50 transition"
              >
                {isVerifying ? '...' : 'Verify'}
              </button>
            </div>
          </div>
          {verifyError && <p className="text-[11px] text-rose-400 mt-1">{verifyError}</p>}
        </div>

        {/* Account ID */}
        <div className="space-y-1.5">
          <label className="text-xs font-semibold text-slate-300 flex items-center justify-between">
            <span className="flex items-center gap-1.5">
              <User className="w-3.5 h-3.5 text-sky-400" />
              <span>Account ID</span>
            </span>
            <span className="text-[11px] text-slate-500">Auto-filled from token</span>
          </label>
          {accounts.length > 0 ? (
            <select
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              className="w-full bg-slate-950 border border-slate-700/80 rounded-xl px-3.5 py-2.5 text-xs text-white focus:outline-none focus:border-sky-500 font-mono"
            >
              {accounts.map((acc) => (
                <option key={acc.id} value={acc.id}>
                  {acc.name} ({acc.id.slice(0, 10)}...)
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              placeholder="Cloudflare account ID..."
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              className="w-full bg-slate-950 border border-slate-700/80 rounded-xl px-3.5 py-2.5 text-xs text-white focus:outline-none focus:border-sky-500 font-mono"
            />
          )}
        </div>

        {/* Worker Script Name */}
        <div className="space-y-1.5">
          <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
            <Cpu className="w-3.5 h-3.5 text-indigo-400" />
            <span>Worker Name</span>
          </label>
          <input
            type="text"
            value={workerName}
            onChange={(e) => setWorkerName(e.target.value)}
            className="w-full bg-slate-950 border border-slate-700/80 rounded-xl px-3.5 py-2.5 text-xs text-white focus:outline-none focus:border-sky-500 font-mono"
          />
        </div>

        {/* Proxy Secret */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
              <Layers className="w-3.5 h-3.5 text-emerald-400" />
              <span>Proxy Secret (32 Hex Characters)</span>
            </label>
            <button
              type="button"
              onClick={generateNewSecret}
              className="text-[11px] text-sky-400 hover:text-sky-300 transition flex items-center gap-1"
            >
              <RefreshCw className="w-3 h-3" />
              <span>Generate Random</span>
            </button>
          </div>
          <input
            type="text"
            value={proxySecret}
            onChange={(e) => setProxySecret(e.target.value)}
            className="w-full bg-slate-950 border border-slate-700/80 rounded-xl px-3.5 py-2.5 text-xs text-white focus:outline-none focus:border-sky-500 font-mono"
          />
        </div>
      </div>

      {deployError && (
        <div className="p-3.5 rounded-xl bg-rose-950/60 border border-rose-800/80 text-xs text-rose-300 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
          <div>{deployError}</div>
        </div>
      )}

      {/* Action Buttons */}
      <div className="flex flex-wrap items-center gap-3 pt-2">
        <button
          onClick={() => onDeploy(false)}
          disabled={isDeploying || !apiToken.trim() || !accountId.trim()}
          className="flex-1 min-w-[220px] flex items-center justify-center gap-2 py-3 px-5 rounded-xl font-semibold text-xs sm:text-sm bg-sky-600 hover:bg-sky-500 text-white shadow-lg shadow-sky-600/20 disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          {isDeploying ? (
            <>
              <RefreshCw className="w-4 h-4 animate-spin" />
              <span>Deploying Multipart Bundle (metadata + DO)...</span>
            </>
          ) : (
            <>
              <Sparkles className="w-4 h-4" />
              <span>Deploy to Cloudflare Workers</span>
            </>
          )}
        </button>

        <button
          onClick={() => onDeploy(true)}
          disabled={isDeploying}
          className="py-3 px-4 rounded-xl font-medium text-xs sm:text-sm bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition"
        >
          Test Simulation
        </button>
      </div>
    </div>
  );
};

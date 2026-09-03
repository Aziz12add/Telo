import React, { useState } from 'react';
import { 
  Cloud, 
  Key, 
  User, 
  Cpu, 
  Sparkles, 
  CheckCircle2, 
  AlertTriangle, 
  RefreshCw, 
  Eye, 
  EyeOff, 
  ExternalLink,
  Zap,
  Server
} from 'lucide-react';
import { CloudflareAccount, DeployResponse } from '../types';

interface CloudflareDeployerProps {
  apiToken: string;
  setApiToken: (token: string) => void;
  accountId: string;
  setAccountId: (id: string) => void;
  workerName: string;
  setWorkerName: (name: string) => void;
  camouflageDomain: string;
  setCamouflageDomain: (dom: string) => void;
  secretHex: string;
  generateNewSecret: () => void;
  onDeploy: (simulate?: boolean) => Promise<void>;
  isDeploying: boolean;
  deployResult: DeployResponse | null;
}

export const CloudflareDeployer: React.FC<CloudflareDeployerProps> = ({
  apiToken,
  setApiToken,
  accountId,
  setAccountId,
  workerName,
  setWorkerName,
  camouflageDomain,
  setCamouflageDomain,
  secretHex,
  generateNewSecret,
  onDeploy,
  isDeploying,
  deployResult
}) => {
  const [showToken, setShowToken] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [accounts, setAccounts] = useState<CloudflareAccount[]>([]);
  const [verifyMessage, setVerifyMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const handleVerifyToken = async () => {
    if (!apiToken.trim()) {
      setVerifyMessage({ type: 'error', text: 'لطفاً ابتدا توکن API کلودفلر را وارد کنید.' });
      return;
    }

    setIsVerifying(true);
    setVerifyMessage(null);

    try {
      const res = await fetch('/api/cloudflare/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiToken: apiToken.trim() })
      });

      const data = await res.json();

      if (data.success) {
        setAccounts(data.accounts || []);
        if (data.accounts && data.accounts.length > 0 && !accountId) {
          setAccountId(data.accounts[0].id);
        }
        setVerifyMessage({
          type: 'success',
          text: `توکن معتبر است! ${data.accounts?.length ? `${data.accounts.length} اکانت شناسایی شد.` : 'دسترسی تأیید شد.'}`
        });
      } else {
        setVerifyMessage({
          type: 'error',
          text: data.error || 'توکن نامعتبر است. دسترسی Workers Scripts:Edit الزامی است.'
        });
      }
    } catch {
      setVerifyMessage({
        type: 'error',
        text: 'خطا در برقراری ارتباط با سرور جهت اعتبارسنجی.'
      });
    } finally {
      setIsVerifying(false);
    }
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 sm:p-7 shadow-xl">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6 pb-4 border-b border-slate-800/80">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400">
            <Cloud className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-base sm:text-lg font-bold text-white flex items-center gap-2">
              <span>تنظیمات و دیپلوی در کلودفلر ورکر (Cloudflare Workers)</span>
            </h2>
            <p className="text-xs text-slate-400">
              با وارد کردن توکن یا استفاده از دمو، ورکر پروکسی در کمتر از چند ثانیه فعال می‌شود.
            </p>
          </div>
        </div>

        {/* Status indicator */}
        {deployResult?.success && (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-950/80 border border-emerald-500/40 text-emerald-300 text-xs font-medium">
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            <span>دیپلوی فعال ({deployResult.isSimulated ? 'دمو' : 'سرور ابری'})</span>
          </div>
        )}
      </div>

      {/* Form Fields Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mb-6">
        {/* API Token Input */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
              <Key className="w-3.5 h-3.5 text-amber-400" />
              <span>توکن API کلودفلر (API Token)</span>
            </label>
            <span className="text-[11px] text-slate-500">نیاز به دسترسی Workers Scripts</span>
          </div>
          <div className="relative flex items-center">
            <input
              id="cf-api-token"
              type={showToken ? 'text' : 'password'}
              placeholder="مثال: q8rW1..._D9xLqA..."
              value={apiToken}
              onChange={(e) => setApiToken(e.target.value)}
              className="w-full bg-slate-950 border border-slate-700/80 rounded-xl px-3.5 py-2.5 pl-20 text-xs text-white placeholder:text-slate-600 focus:outline-none focus:border-sky-500 transition font-mono"
            />
            <div className="absolute left-2 flex items-center gap-1">
              <button
                type="button"
                onClick={() => setShowToken(!showToken)}
                className="p-1 rounded text-slate-400 hover:text-slate-200 transition"
                title={showToken ? 'مخفی‌سازی' : 'نمایش'}
              >
                {showToken ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </button>
              <button
                type="button"
                onClick={handleVerifyToken}
                disabled={isVerifying || !apiToken.trim()}
                className="px-2 py-1 rounded text-[11px] font-medium bg-slate-800 hover:bg-slate-700 text-sky-400 disabled:opacity-50 transition"
              >
                {isVerifying ? '...' : 'بررسی'}
              </button>
            </div>
          </div>
          {verifyMessage && (
            <p className={`text-[11px] mt-1 ${verifyMessage.type === 'success' ? 'text-emerald-400' : 'text-rose-400'}`}>
              {verifyMessage.text}
            </p>
          )}
        </div>

        {/* Account ID Input */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
              <User className="w-3.5 h-3.5 text-sky-400" />
              <span>شناسه اکانت (Account ID)</span>
            </label>
            <span className="text-[11px] text-slate-500">یا انتخاب خودکار از لیست</span>
          </div>
          {accounts.length > 0 ? (
            <select
              id="cf-account-select"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              className="w-full bg-slate-950 border border-slate-700/80 rounded-xl px-3.5 py-2.5 text-xs text-white focus:outline-none focus:border-sky-500 transition font-mono"
            >
              {accounts.map((acc) => (
                <option key={acc.id} value={acc.id}>
                  {acc.name} ({acc.id.slice(0, 8)}...)
                </option>
              ))}
            </select>
          ) : (
            <input
              id="cf-account-id"
              type="text"
              placeholder="مثال: e4b2d1847c16f0a9bc490..."
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              className="w-full bg-slate-950 border border-slate-700/80 rounded-xl px-3.5 py-2.5 text-xs text-white placeholder:text-slate-600 focus:outline-none focus:border-sky-500 transition font-mono"
            />
          )}
        </div>

        {/* Worker Script Name */}
        <div className="space-y-1.5">
          <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
            <Cpu className="w-3.5 h-3.5 text-indigo-400" />
            <span>نام ورکر (Worker Name)</span>
          </label>
          <div className="flex items-center">
            <input
              id="cf-worker-name"
              type="text"
              placeholder="tg-worker-proxy"
              value={workerName}
              onChange={(e) => setWorkerName(e.target.value)}
              className="w-full bg-slate-950 border border-slate-700/80 rounded-xl px-3.5 py-2.5 text-xs text-white placeholder:text-slate-600 focus:outline-none focus:border-sky-500 transition font-mono"
            />
          </div>
        </div>

        {/* Camouflage Domain (TLS SNI) */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
              <Server className="w-3.5 h-3.5 text-emerald-400" />
              <span>دامنه استتار Fake TLS (SNI)</span>
            </label>
            <span className="text-[11px] text-slate-500">جهت عبور از فیلترینگ</span>
          </div>
          <input
            id="cf-camou-domain"
            type="text"
            placeholder="www.google.com"
            value={camouflageDomain}
            onChange={(e) => setCamouflageDomain(e.target.value)}
            className="w-full bg-slate-950 border border-slate-700/80 rounded-xl px-3.5 py-2.5 text-xs text-white placeholder:text-slate-600 focus:outline-none focus:border-sky-500 transition font-mono"
          />
        </div>
      </div>

      {/* Secret Key Display & Refresh */}
      <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-3.5 mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400">کلید رمزنگاری MTProto (Secret 32-hex):</span>
          <span className="text-xs font-mono text-amber-300 bg-amber-950/50 px-2 py-0.5 rounded border border-amber-800/40">
            {secretHex.slice(0, 16)}...{secretHex.slice(-8)}
          </span>
        </div>
        <button
          type="button"
          onClick={generateNewSecret}
          className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200 transition"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          <span>تولید کلید جدید</span>
        </button>
      </div>

      {/* Error alert if any */}
      {deployResult?.error && (
        <div className="mb-5 p-3.5 rounded-xl bg-rose-950/50 border border-rose-800/50 flex items-start gap-2.5 text-xs text-rose-300">
          <AlertTriangle className="w-4 h-4 text-rose-400 flex-shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold mb-0.5">خطا در دیپلوی:</div>
            <div>{deployResult.error}</div>
          </div>
        </div>
      )}

      {/* Success Banner */}
      {deployResult?.success && (
        <div className="mb-5 p-4 rounded-xl bg-emerald-950/40 border border-emerald-600/40 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/20 text-emerald-400 flex items-center justify-center">
              <CheckCircle2 className="w-5 h-5" />
            </div>
            <div>
              <div className="text-xs font-bold text-emerald-300">
                ورکر کلودفلر با موفقیت مستقر شد!
              </div>
              <div className="text-xs text-slate-300 font-mono flex items-center gap-2 mt-0.5">
                <span>آدرس ورکر:</span>
                <a 
                  href={deployResult.workerUrl} 
                  target="_blank" 
                  rel="noreferrer"
                  className="text-sky-400 hover:underline flex items-center gap-1"
                >
                  {deployResult.workerUrl}
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            </div>
          </div>

          <div className="text-xs text-slate-400">
            پروکسی‌های اختصاصی ایرانسل، همراه اول و آسیاتک در بخش پایین آماده اتصال هستند 👇
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          id="btn-deploy-cloudflare"
          onClick={() => onDeploy(false)}
          disabled={isDeploying || !apiToken.trim() || !accountId.trim()}
          className="flex-1 min-w-[200px] flex items-center justify-center gap-2 px-5 py-3 rounded-xl font-semibold text-xs sm:text-sm bg-gradient-to-r from-sky-500 to-indigo-600 hover:from-sky-400 hover:to-indigo-500 text-white shadow-lg shadow-sky-500/20 disabled:opacity-50 disabled:cursor-not-allowed transition"
        >
          {isDeploying ? (
            <>
              <RefreshCw className="w-4 h-4 animate-spin" />
              <span>در حال دیپلوی در شبکه کلودفلر...</span>
            </>
          ) : (
            <>
              <Sparkles className="w-4 h-4" />
              <span>دیپلوی خودکار در کلودفلر (Auto Deploy)</span>
            </>
          )}
        </button>

        <button
          id="btn-simulate-deploy"
          onClick={() => onDeploy(true)}
          disabled={isDeploying}
          className="flex items-center justify-center gap-2 px-4 py-3 rounded-xl font-medium text-xs sm:text-sm bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition"
        >
          <Zap className="w-4 h-4 text-amber-400" />
          <span>تست فوری (حالت دمو بدون توکن)</span>
        </button>
      </div>
    </div>
  );
};

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
  Server,
  Lock,
  Layers
} from 'lucide-react';
import { CloudflareAccount, DeployResponse } from '../types';

interface CloudflareDeployerProps {
  apiToken: string;
  setApiToken: (token: string) => void;
  accountId: string;
  setAccountId: (id: string) => void;
  workerName: string;
  setWorkerName: (name: string) => void;
  proxySecret: string;
  setProxySecret: (sec: string) => void;
  customHostname: string;
  setCustomHostname: (host: string) => void;
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
  proxySecret,
  setProxySecret,
  customHostname,
  setCustomHostname,
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
          text: `توکن تأیید شد! ${data.accounts?.length ? `${data.accounts.length} اکانت شناسایی شد.` : 'دسترسی فعال است.'}`
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
          <div className="w-10 h-10 rounded-xl bg-sky-500/10 border border-sky-500/30 flex items-center justify-center text-sky-400">
            <Cloud className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-base sm:text-lg font-bold text-white flex items-center gap-2">
              <span>دیپلوی خودکار پروکسی تلگرام (Telo v2 + Durable Objects)</span>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-indigo-950 text-indigo-300 border border-indigo-700/60 font-mono">
                Multipart ES Modules
              </span>
            </h2>
            <p className="text-xs text-slate-400">
              دیپلوی ماژولار و استاندارد ورکر با قابلیت اتصال واقعی TCP به دیتاسنتر ۲ تلگرام (آمستردام)
            </p>
          </div>
        </div>

        {deployResult?.success && (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-950/80 border border-emerald-500/40 text-emerald-300 text-xs font-medium">
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            <span>پروکسی مستقر شد ({deployResult.isSimulated ? 'دمو' : 'کلودفلر ابری'})</span>
          </div>
        )}
      </div>

      {/* Security Privacy Notice */}
      <div className="mb-5 p-3 rounded-xl bg-slate-950/70 border border-slate-800 flex items-center gap-2.5 text-xs text-slate-400">
        <Lock className="w-4 h-4 text-emerald-400 shrink-0" />
        <span>
          <strong>حفظ امنیت توکن:</strong> توکن API کلودفلر در هیچ پایگاه‌داده‌ای ذخیره نمی‌شود و مستقیماً فقط در حافظه موقت تب جاری برای استقرار فراخوانی می‌گردد.
        </span>
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
            <span className="text-[11px] text-slate-500">دسترسی: Workers Scripts Edit</span>
          </div>
          <div className="relative flex items-center">
            <input
              id="cf-api-token"
              type={showToken ? 'text' : 'password'}
              placeholder="مثال: v8W3-X..._z99Q..."
              value={apiToken}
              onChange={(e) => setApiToken(e.target.value)}
              className="w-full bg-slate-950 border border-slate-700/80 rounded-xl px-3.5 py-2.5 pl-24 text-xs text-white placeholder:text-slate-600 focus:outline-none focus:border-sky-500 transition font-mono"
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
                className="px-2.5 py-1 rounded text-[11px] font-medium bg-slate-800 hover:bg-slate-700 text-sky-400 disabled:opacity-50 transition"
              >
                {isVerifying ? '...' : 'تأیید توکن'}
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
            <span className="text-[11px] text-slate-500">انتخاب از اکانت‌های شناسایی شده</span>
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
                  {acc.name} ({acc.id.slice(0, 10)}...)
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
          <div className="flex items-center justify-between">
            <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
              <Cpu className="w-3.5 h-3.5 text-indigo-400" />
              <span>نام ورکر (Worker Name)</span>
            </label>
            <span className="text-[11px] text-slate-500">پیشوند استاندارد telo-</span>
          </div>
          <input
            id="cf-worker-name"
            type="text"
            placeholder="telo-proxy"
            value={workerName}
            onChange={(e) => setWorkerName(e.target.value)}
            className="w-full bg-slate-950 border border-slate-700/80 rounded-xl px-3.5 py-2.5 text-xs text-white placeholder:text-slate-600 focus:outline-none focus:border-sky-500 transition font-mono"
          />
        </div>

        {/* Proxy Secret */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
              <Layers className="w-3.5 h-3.5 text-emerald-400" />
              <span>کلید سکرت پروکسی (32 کاراکتر Hex)</span>
            </label>
            <button
              type="button"
              onClick={generateNewSecret}
              className="text-[11px] text-sky-400 hover:text-sky-300 transition flex items-center gap-1"
            >
              <RefreshCw className="w-3 h-3" />
              <span>تولید تصادفی</span>
            </button>
          </div>
          <input
            id="cf-proxy-secret"
            type="text"
            value={proxySecret}
            onChange={(e) => setProxySecret(e.target.value)}
            className="w-full bg-slate-950 border border-slate-700/80 rounded-xl px-3.5 py-2.5 text-xs text-white placeholder:text-slate-600 focus:outline-none focus:border-sky-500 transition font-mono"
          />
        </div>
      </div>

      {/* Error alert if any */}
      {deployResult?.error && (
        <div className="mb-5 p-3.5 rounded-xl bg-rose-950/50 border border-rose-800/50 flex items-start gap-2.5 text-xs text-rose-300">
          <AlertTriangle className="w-4 h-4 text-rose-400 flex-shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold mb-0.5">خطا در بارگذاری یا فعال‌سازی:</div>
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
                ورکر با موفقیت مستقر شد و روتینگ workers.dev فعال است!
              </div>
              <div className="text-xs text-slate-300 font-mono flex items-center gap-2 mt-0.5">
                <span>دامنه مستقیم:</span>
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
            لینک‌های پروکسی و تنظیمات اپراتورها در پایین آماده اتصال است 👇
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
              <span>در حال ارسال پکیج ماژولار و تنظیم Durable Object...</span>
            </>
          ) : (
            <>
              <Sparkles className="w-4 h-4" />
              <span>دیپلوی خودکار پکیج در کلودفلر (Multipart Deploy)</span>
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
          <span>تست دمو (آزمایش سریع رابط و لینک‌ها)</span>
        </button>
      </div>
    </div>
  );
};

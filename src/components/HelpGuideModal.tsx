import React from 'react';
import { X, Key, Cloud, Send, CheckCircle2, AlertCircle, ExternalLink, ShieldAlert, Cpu } from 'lucide-react';

interface HelpGuideModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const HelpGuideModal: React.FC<HelpGuideModalProps> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="flex items-center justify-between p-4 sm:p-5 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-sky-500/20 text-sky-400 flex items-center justify-center">
              <Key className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm sm:text-base font-bold text-white">
                راهنمای راه‌اندازی پروکسی تلگرام Telo v2 در کلودفلر
              </h3>
              <p className="text-[11px] text-slate-400">
                مراحل دریافت دسترسی، ساختار فنی اتصال و نکات مهم قوانین کلودفلر
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-auto p-5 space-y-6 text-xs sm:text-sm text-slate-300">
          {/* Step 1 */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 font-bold text-sky-400 text-sm">
              <span className="w-5 h-5 rounded-full bg-sky-500/20 text-sky-300 flex items-center justify-center text-xs">1</span>
              <span>نحوه ساخت API Token در کلودفلر (۳۰ ثانیه):</span>
            </div>
            <p className="text-slate-400 leading-relaxed pr-7">
              ۱. وارد داشبورد کلودفلر بخش توکن‌ها شوید:{' '}
              <a 
                href="https://dash.cloudflare.com/profile/api-tokens" 
                target="_blank" 
                rel="noreferrer"
                className="text-sky-400 hover:underline inline-flex items-center gap-1 font-mono"
              >
                dash.cloudflare.com/profile/api-tokens
                <ExternalLink className="w-3 h-3" />
              </a>
              <br />
              ۲. دکمه <strong className="text-white">Create Token</strong> را بزنید.
              <br />
              ۳. الگوی <strong className="text-white">Edit Cloudflare Workers</strong> را انتخاب کنید.
              <br />
              ۴. دسترسی‌های زیر باید فعال باشند:
              <br />
              • <code className="text-emerald-400 bg-slate-950 px-1 rounded">Account: Workers Scripts (Edit)</code>
              <br />
              • <code className="text-emerald-400 bg-slate-950 px-1 rounded">Account: Workers Subdomain (Read/Edit)</code>
              <br />
              ۵. روی دکمه <strong className="text-white">Continue to summary</strong> و سپس <strong className="text-white">Create Token</strong> بزنید و توکن تولید شده را کپی کنید.
            </p>
          </div>

          {/* Step 2 */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 font-bold text-indigo-400 text-sm">
              <span className="w-5 h-5 rounded-full bg-indigo-500/20 text-indigo-300 flex items-center justify-center text-xs">2</span>
              <span>معماری فنی پروکسی چگونه است؟</span>
            </div>
            <p className="text-slate-400 leading-relaxed pr-7">
              پروکسی Telo از پکیج ماژولار با پشتیبانی از <code>cloudflare:sockets</code> و Durable Objects بهره می‌برد:
              <br />
              • درخواست کلاینت ورکر را بیدار کرده و اتصال مستقیم TCP با دیتاسنتر اصلی تلگرام (DC2 در هلند/آمستردام: <code>149.154.167.51:443</code>) برقرار می‌کند.
              <br />
              • سکرت به صورت ۳۲ کاراکتر هگزادسیمال با هندشیک رمزنگاری‌شده AES-CTR کار می‌کند.
              <br />
              • برای اپراتورهای ایرانسل، همراه اول و آسیاتک می‌توانید هم از دامنه مستقیم ورکر و هم از آی‌پی‌های تمیز Anycast استفاده کنید.
            </p>
          </div>

          {/* Step 3: Limitations & CF ToS */}
          <div className="p-3.5 bg-amber-950/40 border border-amber-800/60 rounded-xl space-y-1.5">
            <div className="font-semibold text-amber-300 flex items-center gap-1.5 text-xs">
              <ShieldAlert className="w-4 h-4 text-amber-400" />
              <span>محدودیت‌ها و قوانین کلودفلر (Terms of Service):</span>
            </div>
            <p className="text-slate-400 text-xs leading-relaxed">
              • در پلن رایگان کلودفلر، محدودیت ۱۰۰،۰۰۰ ریکوئست در روز وجود دارد که برای ارسال پیام‌های متنی و چت‌های معمولی کاملاً کافیست اما برای دانلود فایل‌های بسیار حجیم چند گیگابایتی پیشنهاد نمی‌شود.
              <br />
              • تماس صوتی و تصویری تلگرام بر بستر UDP کار می‌کند، در حالی که ورکرها پروتکل TCP را رله می‌کنند؛ لذا تماس‌های صوتی معمولاً از مسیر مستقیم P2P خود تلگرام عبور داده می‌شوند.
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 bg-slate-900 border-t border-slate-800 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold transition"
          >
            بستن راهنما
          </button>
        </div>
      </div>
    </div>
  );
};

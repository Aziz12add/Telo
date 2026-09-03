import React from 'react';
import { X, Key, Cloud, Send, CheckCircle2, AlertCircle, ExternalLink } from 'lucide-react';

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
                راهنمای دیپلوی و راه‌اندازی پروکسی تلگرام
              </h3>
              <p className="text-[11px] text-slate-400">
                مراحل دریافت توکن کلودفلر و تنظیم پروکسی برای ایرانسل، همراه اول و آسیاتک
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
              <span>نحوه دریافت توکن API کلودفلر (۳۰ ثانیه):</span>
            </div>
            <p className="text-slate-400 leading-relaxed pr-7">
              ۱. وارد داشبورد کلودفلر شوید:{' '}
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
              ۲. روی دکمه آبی <strong className="text-white">Create Token</strong> کلیک کنید.
              <br />
              ۳. الگوی <strong className="text-white">Edit Cloudflare Workers</strong> را انتخاب کنید (روی دکمه Use template کلیک کنید).
              <br />
              ۴. در پایین صفحه روی <strong className="text-white">Continue to summary</strong> و سپس <strong className="text-white">Create Token</strong> بزنید و توکن تولید شده را کپی نمایید.
            </p>
          </div>

          {/* Step 2 */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 font-bold text-amber-400 text-sm">
              <span className="w-5 h-5 rounded-full bg-amber-500/20 text-amber-300 flex items-center justify-center text-xs">2</span>
              <span>دیپلوی خودکار در اپلیکیشن:</span>
            </div>
            <p className="text-slate-400 leading-relaxed pr-7">
              توکن خود را در فیلد مربوطه قرار دهید و روی «بررسی» کلیک کنید تا اکانت شما به‌صورت خودکار انتخاب شود. سپس با زدن دکمه <strong className="text-white">«دیپلوی خودکار در کلودفلر»</strong> ورکر در سرورهای ابری ساخته و فعال می‌گردد. همچنین برای آزمایش اولیه می‌توانید از دکمه <strong className="text-white">«تست فوری (دمو)»</strong> استفاده کنید.
            </p>
          </div>

          {/* Step 3 */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 font-bold text-emerald-400 text-sm">
              <span className="w-5 h-5 rounded-full bg-emerald-500/20 text-emerald-300 flex items-center justify-center text-xs">3</span>
              <span>تفاوت پروکسی‌ها برای ایرانسل، همراه اول و آسیاتک:</span>
            </div>
            <p className="text-slate-400 leading-relaxed pr-7">
              سیاست‌های مسدودسازی و مسیریابی هر اپراتور در ایران متفاوت است:
              <br />
              • <strong className="text-amber-300">ایرانسل (MTN):</strong> به آی‌پی‌های رنج صوفیه و فرانکفورت کلودفلر (مانند 188.114.97.3) حساسیت کمتری دارد و پینگ پایدارتری می‌دهد.
              <br />
              • <strong className="text-cyan-300">همراه اول (MCI):</strong> روی آی‌پی‌های رنج 104.16 و 172.67 عملکرد عالی با حداقل پکت‌لاس دارد.
              <br />
              • <strong className="text-indigo-300">آسیاتک:</strong> روی آی‌پی‌های رنج 104.19 و 198.41 با پورت 443 و استتار Fake TLS بالاترین سرعت دانلود را دارد.
            </p>
          </div>

          {/* Step 4: Troubleshooting */}
          <div className="p-3.5 bg-slate-950 border border-slate-800 rounded-xl space-y-1.5">
            <div className="font-semibold text-white flex items-center gap-1.5 text-xs">
              <AlertCircle className="w-4 h-4 text-amber-400" />
              <span>نکته در صورت متصل نشدن تلگرام:</span>
            </div>
            <p className="text-slate-400 text-xs leading-relaxed">
              اگر در تلگرام وضعیت در حالت «Connecting...» ماند، کافیست در بخش «آی‌پی‌های تمیز» یک آی‌پی دیگر را انتخاب کرده یا دکمه «تست پینگ» را بزنید تا آی‌پی با پینگ پایین‌تر جایگزین شود. همچنین دامنه استتار Fake TLS به‌صورت خودکار بر روی دامنه معتبر گوگل تنظیم شده است.
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 bg-slate-900 border-t border-slate-800 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold transition"
          >
            متوجه شدم، بستن راهنما
          </button>
        </div>
      </div>
    </div>
  );
};

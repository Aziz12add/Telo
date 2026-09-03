import React, { useState } from 'react';
import { X, Copy, Check, Share2, Send } from 'lucide-react';
import { OperatorProxyConfig } from '../types';

interface BulkExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  operatorConfigs: Record<string, OperatorProxyConfig>;
  workerUrl: string;
}

export const BulkExportModal: React.FC<BulkExportModalProps> = ({
  isOpen,
  onClose,
  operatorConfigs,
  workerUrl
}) => {
  const [copied, setCopied] = useState(false);

  if (!isOpen) return null;

  const irancell = operatorConfigs['irancell'];
  const mci = operatorConfigs['mci'];
  const asiatech = operatorConfigs['asiatech'];
  const other = operatorConfigs['other'];

  const exportText = `🚀 پروکسی‌های قدرتمند تلگرام (کلودفلر ورکر Anycast)
🛡 ضد فیلتر با استتار TLS و آی‌پی تمیز تفکیک شده بر اساس اپراتور:

🟡 مخصوص ایرانسل (Irancell / MTN):
🔗 ${irancell?.proxyLink || ''}
⚡️ آی‌پی تمیز: ${irancell?.selectedCleanIp || ''}

🔵 مخصوص همراه اول (MCI / Hamrah Aval):
🔗 ${mci?.proxyLink || ''}
⚡️ آی‌پی تمیز: ${mci?.selectedCleanIp || ''}

🟣 مخصوص آسیاتک (Asiatech):
🔗 ${asiatech?.proxyLink || ''}
⚡️ آی‌پی تمیز: ${asiatech?.selectedCleanIp || ''}

🟢 سایر اپراتورها (مخابرات، رایتل، های‌وب):
🔗 ${other?.proxyLink || ''}

🌐 سرور ورکر کلودفلر:
${workerUrl || 'فعال'}

📌 جهت اتصال، روی لینک اپراتور خود کلیک کرده و Connect Proxy را بزنید.`;

  const handleCopy = () => {
    navigator.clipboard.writeText(exportText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="flex items-center justify-between p-4 sm:p-5 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/20 text-emerald-400 flex items-center justify-center">
              <Share2 className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm sm:text-base font-bold text-white">
                خروجی گروهی پروکسی‌ها برای اشتراک‌گذاری
              </h3>
              <p className="text-[11px] text-slate-400">
                متن آماده برای ارسال در کانال‌ها و گروه‌های تلگرام
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

        {/* Content */}
        <div className="flex-1 overflow-auto p-4 bg-slate-950">
          <textarea
            readOnly
            value={exportText}
            rows={14}
            className="w-full bg-slate-900 border border-slate-800 rounded-xl p-3.5 text-xs text-slate-200 font-sans leading-relaxed focus:outline-none resize-none select-all"
          />
        </div>

        {/* Footer */}
        <div className="p-4 bg-slate-900 border-t border-slate-800 flex items-center justify-between gap-3">
          <span className="text-xs text-slate-400">
            شامل ۳ اپراتور اصلی (ایرانسل، همراه اول، آسیاتک)
          </span>

          <div className="flex items-center gap-2">
            <button
              onClick={handleCopy}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white transition shadow-sm"
            >
              {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              <span>{copied ? 'متن کپی شد!' : 'کپی کل متن'}</span>
            </button>

            <button
              onClick={onClose}
              className="px-3 py-2 rounded-lg text-xs text-slate-400 hover:text-slate-200 transition"
            >
              بستن
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

import React, { useState, useEffect } from 'react';
import QRCode from 'qrcode';
import { 
  Send, 
  Copy, 
  Check, 
  QrCode, 
  Download, 
  ExternalLink, 
  ShieldCheck, 
  Sparkles,
  Bot,
  Activity
} from 'lucide-react';
import { OperatorProxyConfig } from '../types';

interface ProxyCardProps {
  config: OperatorProxyConfig;
  workerUrl: string;
}

export const ProxyCard: React.FC<ProxyCardProps> = ({ config, workerUrl }) => {
  const [copied, setCopied] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [showQrModal, setShowQrModal] = useState(false);

  // Generate QR code for the telegram deep link
  useEffect(() => {
    if (config.telegramDeepLink) {
      QRCode.toDataURL(config.telegramDeepLink, {
        width: 320,
        margin: 2,
        color: {
          dark: '#0f172a',
          light: '#ffffff'
        }
      })
        .then((url) => setQrDataUrl(url))
        .catch((err) => console.error('QR generation error:', err));
    }
  }, [config.telegramDeepLink]);

  const handleCopy = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 2000);
  };

  const downloadQrCode = () => {
    if (!qrDataUrl) return;
    const a = document.createElement('a');
    a.href = qrDataUrl;
    a.download = `telegram-proxy-${config.id}.png`;
    a.click();
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 sm:p-6 shadow-xl relative overflow-hidden">
      {/* Top Banner with Operator theme */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5 pb-4 border-b border-slate-800">
        <div className="flex items-center gap-3">
          <div 
            className="w-11 h-11 rounded-xl flex items-center justify-center font-bold text-white shadow-md text-base"
            style={{ backgroundColor: config.color }}
          >
            {config.badge}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-bold text-white">{config.nameFa}</h3>
              <span className="text-xs px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 font-mono">
                {config.nameEn}
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              پروکسی MTProto با استتار TLS و آی‌پی تمیز کلودفلر
            </p>
          </div>
        </div>

        {/* Selected Clean IP pill */}
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-xs">
          <span className="text-slate-400">آی‌پی تمیز فعال:</span>
          <span className="font-mono text-amber-300 font-semibold">{config.selectedCleanIp}</span>
          <span className="text-slate-500">پورت: 443</span>
        </div>
      </div>

      {/* Main Connection Panel */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
        {/* Left 2 Cols: Details & Actions */}
        <div className="lg:col-span-2 space-y-4">
          {/* Main Direct Telegram Connect Button */}
          <a
            id={`btn-connect-${config.id}`}
            href={config.telegramDeepLink}
            target="_blank"
            rel="noreferrer"
            className="w-full flex items-center justify-center gap-3 px-6 py-4 rounded-xl font-bold text-base text-white shadow-lg transition transform active:scale-[0.99]"
            style={{ 
              background: `linear-gradient(135deg, ${config.color}, #2563eb)`,
              boxShadow: `0 10px 25px -5px ${config.color}40`
            }}
          >
            <Send className="w-5 h-5" />
            <span>اتصال مستقیم به تلگرام ({config.nameFa})</span>
          </a>

          {/* Quick link fields */}
          <div className="space-y-2">
            {/* Telegram Deep Link */}
            <div className="space-y-1">
              <label className="text-[11px] font-semibold text-slate-400">لینک اختصاصی تلگرام (tg://proxy):</label>
              <div className="flex items-center gap-1.5 bg-slate-950 border border-slate-800 rounded-xl p-1.5 pr-3">
                <span className="font-mono text-xs text-slate-300 truncate flex-1 direction-ltr text-left">
                  {config.telegramDeepLink}
                </span>
                <button
                  id={`btn-copy-deep-${config.id}`}
                  onClick={() => handleCopy(config.telegramDeepLink, 'deep')}
                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 transition shrink-0"
                >
                  {copied === 'deep' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copied === 'deep' ? 'کپی شد' : 'کپی'}</span>
                </button>
              </div>
            </div>

            {/* Web Link (t.me/proxy) */}
            <div className="space-y-1">
              <label className="text-[11px] font-semibold text-slate-400">لینک تحت وب (t.me/proxy):</label>
              <div className="flex items-center gap-1.5 bg-slate-950 border border-slate-800 rounded-xl p-1.5 pr-3">
                <span className="font-mono text-xs text-slate-300 truncate flex-1 direction-ltr text-left">
                  {config.proxyLink}
                </span>
                <button
                  id={`btn-copy-web-${config.id}`}
                  onClick={() => handleCopy(config.proxyLink, 'web')}
                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 transition shrink-0"
                >
                  {copied === 'web' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copied === 'web' ? 'کپی شد' : 'کپی'}</span>
                </button>
              </div>
            </div>
          </div>

          {/* Bot API Endpoint for Developers */}
          <div className="p-3 bg-slate-950/70 border border-slate-800/80 rounded-xl">
            <div className="flex items-center justify-between gap-2 mb-1">
              <span className="text-[11px] font-semibold text-sky-400 flex items-center gap-1">
                <Bot className="w-3.5 h-3.5" />
                <span>پروکسی ربات تلگرام (Telegram Bot API Gateway):</span>
              </span>
              <button
                onClick={() => handleCopy(config.botApiUrl, 'bot')}
                className="text-[11px] text-slate-400 hover:text-slate-200 flex items-center gap-1"
              >
                {copied === 'bot' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                <span>کپی آدرس Bot API</span>
              </button>
            </div>
            <div className="font-mono text-xs text-slate-300 truncate direction-ltr text-left bg-slate-900/60 p-1.5 rounded border border-slate-800">
              {config.botApiUrl}
            </div>
          </div>
        </div>

        {/* Right 1 Col: QR Code Box */}
        <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 flex flex-col items-center justify-center text-center">
          <div className="text-xs font-semibold text-slate-300 mb-2 flex items-center gap-1.5">
            <QrCode className="w-4 h-4 text-sky-400" />
            <span>اسکن با دوربین یا تلگرام</span>
          </div>

          {qrDataUrl ? (
            <div className="bg-white p-2 rounded-xl shadow-md mb-3">
              <img 
                src={qrDataUrl} 
                alt="Telegram Proxy QR Code" 
                className="w-40 h-40 object-contain rounded-lg"
              />
            </div>
          ) : (
            <div className="w-40 h-40 bg-slate-900 rounded-xl flex items-center justify-center text-xs text-slate-500 mb-3">
              در حال تولید QR...
            </div>
          )}

          <button
            onClick={downloadQrCode}
            disabled={!qrDataUrl}
            className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition"
          >
            <Download className="w-3.5 h-3.5" />
            <span>دانلود تصویر QR کد</span>
          </button>
        </div>
      </div>
    </div>
  );
};

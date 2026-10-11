import React from 'react';
import { X, Key, ExternalLink, ShieldAlert, CheckCircle2, Globe2 } from 'lucide-react';

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
              <Globe2 className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm sm:text-base font-bold text-white">
                Telegram Official WEB Proxy v1 Guide
              </h3>
              <p className="text-[11px] text-slate-400">
                Setup guide &bull; Connection instructions &bull; Cloudflare limits
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
          {/* Step 1: Token */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 font-bold text-sky-400 text-sm">
              <span className="w-5 h-5 rounded-full bg-sky-500/20 text-sky-300 flex items-center justify-center text-xs">1</span>
              <span>Create Cloudflare API Token (30 seconds):</span>
            </div>
            <p className="text-slate-400 leading-relaxed pr-7">
              1. Open Cloudflare API Tokens page:{' '}
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
              2. Click <strong>Create Token</strong> &rarr; use the <strong>Edit Cloudflare Workers</strong> template.
              <br />
              3. Required permissions:
              <br />
              &bull; <code className="text-emerald-400 bg-slate-950 px-1 rounded">Account &gt; Workers Scripts &gt; Edit</code>
              <br />
              &bull; <code className="text-emerald-400 bg-slate-950 px-1 rounded">Account &gt; Workers Subdomain &gt; Edit</code>
              <br />
              &bull; <code className="text-emerald-400 bg-slate-950 px-1 rounded">Account &gt; Account Settings &gt; Read</code>
              <br />
              4. Complete wizard and copy the generated token into Telo.
            </p>
          </div>

          {/* Step 2: How to Connect in Telegram */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 font-bold text-emerald-400 text-sm">
              <span className="w-5 h-5 rounded-full bg-emerald-500/20 text-emerald-300 flex items-center justify-center text-xs">2</span>
              <span>How to connect in Telegram:</span>
            </div>
            <p className="text-slate-400 leading-relaxed pr-7">
              In Telegram:
              <br />
              &bull; Open <strong>Settings &rarr; Data and Storage &rarr; Proxy Settings &rarr; Add Proxy</strong>.
              <br />
              &bull; Choose <strong>WEB Proxy</strong> (do NOT choose SOCKS5 or classic MTProto).
              <br />
              &bull; Paste your worker <strong>Hostname</strong> (e.g. <code className="text-white">myproxy.sub.workers.dev</code> without <code className="text-slate-500">https://</code>) and <strong>Secret</strong> (32 hex characters).
              <br />
              &bull; Or simply click the generated <code className="text-sky-400">https://t.me/webproxy?server=...&secret=...</code> link!
            </p>
          </div>

          {/* Step 3: Limitations & CF ToS */}
          <div className="p-3.5 bg-amber-950/40 border border-amber-800/60 rounded-xl space-y-1.5">
            <div className="font-semibold text-amber-300 flex items-center gap-1.5 text-xs">
              <ShieldAlert className="w-4 h-4 text-amber-400" />
              <span>Technical Notes &amp; Limits:</span>
            </div>
            <p className="text-slate-400 text-xs leading-relaxed">
              &bull; <strong>Official Protocol:</strong> This uses the Telegram official WEB Proxy v1 bridge protocol over HTTPS / WebSockets (port 443).
              <br />
              &bull; <strong>Cloudflare Free Tier:</strong> 100,000 requests/day allowance.
              <br />
              &bull; <strong>Voice/Video Calls:</strong> Telegram voice calls rely on peer-to-peer UDP and may not route through TCP web proxies.
              <br />
              &bull; <strong>Access Control:</strong> The 32-hex secret acts as HMAC access control; requests without the valid HMAC bridge capability token receive an innocuous decoy page.
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 bg-slate-900 border-t border-slate-800 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold transition"
          >
            Close / بستن
          </button>
        </div>
      </div>
    </div>
  );
};

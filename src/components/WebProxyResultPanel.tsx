import React, { useState } from 'react';
import { Copy, Check, ExternalLink, Send } from 'lucide-react';

export interface WebProxyResultProps {
  hostname: string;
  secret: string;
  tmeLink: string;
  tgLink: string;
}

export const WebProxyResultPanel: React.FC<WebProxyResultProps> = ({
  hostname,
  secret,
  tmeLink,
  tgLink,
}) => {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const handleCopy = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 sm:p-7 shadow-2xl space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-slate-800">
        <div>
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-950 text-emerald-400 border border-emerald-800/80 mb-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            Telegram Web Proxy v1 Active
          </span>
          <h2 className="text-xl font-bold text-white tracking-tight">
            Proxy Deployment Result
          </h2>
        </div>
      </div>

      {/* Primary Details: Hostname & Secret */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Hostname */}
        <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-400">Hostname</span>
            <button
              onClick={() => handleCopy(hostname, 'host')}
              className="text-xs text-sky-400 hover:text-sky-300 flex items-center gap-1 transition"
            >
              {copiedKey === 'host' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copiedKey === 'host' ? 'Copied' : 'Copy'}</span>
            </button>
          </div>
          <div className="font-mono text-sm text-slate-200 select-all break-all">
            {hostname}
          </div>
        </div>

        {/* Secret */}
        <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-400">Secret</span>
            <button
              onClick={() => handleCopy(secret, 'secret')}
              className="text-xs text-sky-400 hover:text-sky-300 flex items-center gap-1 transition"
            >
              {copiedKey === 'secret' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copiedKey === 'secret' ? 'Copied' : 'Copy'}</span>
            </button>
          </div>
          <div className="font-mono text-sm text-amber-300 select-all break-all">
            {secret}
          </div>
        </div>
      </div>

      {/* Connection Links */}
      <div className="space-y-4">
        {/* https://t.me/webproxy Link */}
        <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-400">Official Web Proxy Link (t.me)</span>
            <button
              onClick={() => handleCopy(tmeLink, 'tme')}
              className="text-xs text-sky-400 hover:text-sky-300 flex items-center gap-1 transition"
            >
              {copiedKey === 'tme' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copiedKey === 'tme' ? 'Copied' : 'Copy'}</span>
            </button>
          </div>
          <div className="font-mono text-xs text-slate-300 break-all bg-slate-900/80 p-2.5 rounded-lg border border-slate-800/80 select-all">
            {tmeLink}
          </div>
          <a
            href={tmeLink}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-sky-400 hover:text-sky-300 mt-1 transition"
          >
            <span>Open in Browser</span>
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </div>

        {/* tg://webproxy Link */}
        <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-400">Telegram App Deep Link (tg://)</span>
            <button
              onClick={() => handleCopy(tgLink, 'tg')}
              className="text-xs text-sky-400 hover:text-sky-300 flex items-center gap-1 transition"
            >
              {copiedKey === 'tg' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copiedKey === 'tg' ? 'Copied' : 'Copy'}</span>
            </button>
          </div>
          <div className="font-mono text-xs text-slate-300 break-all bg-slate-900/80 p-2.5 rounded-lg border border-slate-800/80 select-all">
            {tgLink}
          </div>
          <a
            href={tgLink}
            className="flex items-center justify-center gap-2 w-full py-3 px-4 rounded-xl font-bold text-sm bg-sky-600 hover:bg-sky-500 text-white shadow-lg shadow-sky-600/25 transition mt-2"
          >
            <Send className="w-4 h-4" />
            <span>Connect in Telegram</span>
          </a>
        </div>
      </div>
    </div>
  );
};

import React from 'react';
import { HelpCircle, Code, Globe2 } from 'lucide-react';

interface HeaderProps {
  onOpenHelp: () => void;
  onOpenCode: () => void;
  hostname: string | null;
}

export const Header: React.FC<HeaderProps> = ({
  onOpenHelp,
  onOpenCode,
  hostname,
}) => {
  return (
    <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur-md sticky top-0 z-40">
      <div className="max-w-4xl mx-auto px-4 py-3.5 flex flex-wrap items-center justify-between gap-4">
        {/* Title & Brand */}
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-sky-500 to-indigo-600 flex items-center justify-center text-white shadow-lg shadow-sky-500/20">
            <Globe2 className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base sm:text-lg font-bold text-white tracking-tight">
                Telo — Telegram Web Proxy v1 Deployer
              </h1>
              <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold bg-sky-950 text-sky-400 border border-sky-800/60">
                Official Protocol
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Deploy official Telegram WEB Proxy to Cloudflare Workers with Durable Objects
            </p>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-2">
          {hostname && (
            <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-lg bg-emerald-950/60 border border-emerald-700/50 text-xs text-emerald-400 font-mono">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span className="truncate max-w-[200px]" title={hostname}>
                {hostname}
              </span>
            </div>
          )}

          <button
            onClick={onOpenCode}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition"
          >
            <Code className="w-4 h-4 text-sky-400" />
            <span>Worker Source</span>
          </button>

          <button
            onClick={onOpenHelp}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-sky-600 hover:bg-sky-500 text-white shadow-sm transition"
          >
            <HelpCircle className="w-4 h-4" />
            <span>Guide / راهنما</span>
          </button>
        </div>
      </div>
    </header>
  );
};

import React from 'react';
import { ShieldCheck, HelpCircle, Code, Share2, Globe2 } from 'lucide-react';

interface HeaderProps {
  onOpenHelp: () => void;
  onOpenCode: () => void;
  onOpenExport: () => void;
  isDeployed: boolean;
  workerUrl: string | null;
}

export const Header: React.FC<HeaderProps> = ({
  onOpenHelp,
  onOpenCode,
  onOpenExport,
  isDeployed,
  workerUrl
}) => {
  return (
    <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur-md sticky top-0 z-40">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3.5 flex flex-wrap items-center justify-between gap-4">
        {/* Title & Brand */}
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-sky-500 to-indigo-600 flex items-center justify-center text-white shadow-lg shadow-sky-500/20">
            <Globe2 className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg sm:text-xl font-bold text-white tracking-tight">
                دیپلوی خودکار پروکسی تلگرام کلودفلر
              </h1>
              <span className="hidden sm:inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-sky-950 text-sky-400 border border-sky-800/60">
                v2.0 Anycast
              </span>
            </div>
            <p className="text-xs text-slate-400">
              تولید و تنظیم خودکار پروکسی تلگرام با آی‌پی تمیز برای ایرانسل، همراه اول و آسیاتک
            </p>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-2">
          {isDeployed && workerUrl && (
            <div className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-lg bg-emerald-950/60 border border-emerald-700/50 text-xs text-emerald-400 font-mono">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span className="truncate max-w-[200px]" title={workerUrl}>{workerUrl.replace('https://', '')}</span>
            </div>
          )}

          <button
            id="header-code-btn"
            onClick={onOpenCode}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition"
          >
            <Code className="w-4 h-4 text-sky-400" />
            <span className="hidden sm:inline">کد ورکر</span>
          </button>

          <button
            id="header-export-btn"
            onClick={onOpenExport}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition"
          >
            <Share2 className="w-4 h-4 text-emerald-400" />
            <span>خروجی گروهی</span>
          </button>

          <button
            id="header-help-btn"
            onClick={onOpenHelp}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-sky-600 hover:bg-sky-500 text-white shadow-sm transition"
          >
            <HelpCircle className="w-4 h-4" />
            <span>راهنما</span>
          </button>
        </div>
      </div>
    </header>
  );
};

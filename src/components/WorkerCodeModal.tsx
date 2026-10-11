import React, { useState } from 'react';
import { X, Copy, Check, Code, ExternalLink, Terminal, Layers } from 'lucide-react';
import { generateWebProxyBundle } from '../worker-runtime/bundle';

interface WorkerCodeModalProps {
  isOpen: boolean;
  onClose: () => void;
  workerName: string;
  proxySecret: string;
}

export const WorkerCodeModal: React.FC<WorkerCodeModalProps> = ({
  isOpen,
  onClose,
  workerName,
  proxySecret,
}) => {
  const [copied, setCopied] = useState(false);
  const [activeFile, setActiveFile] = useState<string>('index.js');

  if (!isOpen) return null;

  let fileContent = '';
  try {
    const bundle = generateWebProxyBundle({
      workerName: workerName || 'telo-webproxy',
      proxySecret: proxySecret || '000102030405060708090a0b0c0d0e0f',
    });

    fileContent =
      activeFile === 'metadata.json'
        ? JSON.stringify(bundle.metadata, null, 2)
        : bundle.files[activeFile] || '';
  } catch {
    fileContent = '// Source bundle available in root repository (index.js, session.js, protocol.js)';
  }

  const handleCopy = () => {
    navigator.clipboard.writeText(fileContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-4xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-4 sm:p-5 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-sky-500/20 text-sky-400 flex items-center justify-center">
              <Layers className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm sm:text-base font-bold text-white">
                Telegram Web Proxy v1 Runtime Modules
              </h3>
              <p className="text-[11px] text-slate-400">
                Single source of truth modules deployed to Cloudflare Workers
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleCopy}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium bg-sky-600 hover:bg-sky-500 text-white transition"
            >
              {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copied ? 'Copied' : `Copy ${activeFile}`}</span>
            </button>

            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* File Tabs */}
        <div className="bg-slate-950 px-4 py-2 border-b border-slate-800/80 flex items-center gap-2 overflow-x-auto">
          {['index.js', 'session.js', 'protocol.js', 'metadata.json'].map((f) => (
            <button
              key={f}
              onClick={() => setActiveFile(f)}
              className={`px-3 py-1 rounded-md text-xs font-mono transition ${
                activeFile === f
                  ? 'bg-slate-800 text-sky-400 font-semibold border border-slate-700'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
              }`}
            >
              {f}
            </button>
          ))}
        </div>

        {/* Code Content */}
        <div className="flex-1 overflow-auto p-4 bg-slate-950">
          <pre className="font-mono text-xs text-emerald-300 leading-relaxed overflow-x-auto p-3 select-all direction-ltr text-left">
            <code>{fileContent}</code>
          </pre>
        </div>

        {/* Footer */}
        <div className="p-4 bg-slate-900 border-t border-slate-800 text-xs text-slate-400 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Terminal className="w-4 h-4 text-amber-400" />
            <span>Deployed automatically as a multi-module ES package with SQLite Durable Objects.</span>
          </div>
          <button
            onClick={onClose}
            className="text-xs text-slate-400 hover:text-slate-200"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

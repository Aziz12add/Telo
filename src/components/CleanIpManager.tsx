import React, { useState } from 'react';
import { 
  Activity, 
  CheckCircle, 
  Radio, 
  Plus, 
  RefreshCw, 
  Signal, 
  Zap, 
  MapPin,
  Check
} from 'lucide-react';
import { CleanIPItem, OperatorType } from '../types';

interface CleanIpManagerProps {
  operator: OperatorType;
  operatorNameFa: string;
  cleanIps: CleanIPItem[];
  selectedIp: string;
  onSelectIp: (ip: string) => void;
  onAddCustomIp: (ip: string) => void;
  onTestIp: (ipItem: CleanIPItem) => Promise<void>;
  onTestAllIps: () => Promise<void>;
  isTestingAll: boolean;
}

export const CleanIpManager: React.FC<CleanIpManagerProps> = ({
  operator,
  operatorNameFa,
  cleanIps,
  selectedIp,
  onSelectIp,
  onAddCustomIp,
  onTestIp,
  onTestAllIps,
  isTestingAll
}) => {
  const [customIpInput, setCustomIpInput] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);

  const handleAddSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = customIpInput.trim();
    if (trimmed) {
      onAddCustomIp(trimmed);
      setCustomIpInput('');
      setShowAddModal(false);
    }
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 sm:p-6 shadow-xl">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4 pb-3 border-b border-slate-800">
        <div>
          <h4 className="text-sm sm:text-base font-bold text-white flex items-center gap-2">
            <Signal className="w-4 h-4 text-sky-400" />
            <span>آی‌پی‌های تمیز کلودفلر برای {operatorNameFa}</span>
          </h4>
          <p className="text-xs text-slate-400 mt-0.5">
            آی‌پی با کمترین پینگ را انتخاب کنید تا پروکسی بدون تأخیر متصل شود.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            id="btn-test-all-ips"
            onClick={onTestAllIps}
            disabled={isTestingAll}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-sky-300 border border-slate-700 transition"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isTestingAll ? 'animate-spin text-sky-400' : ''}`} />
            <span>{isTestingAll ? 'در حال تست پینگ...' : 'تست پینگ همه'}</span>
          </button>

          <button
            id="btn-add-custom-ip"
            onClick={() => setShowAddModal(!showAddModal)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition"
          >
            <Plus className="w-3.5 h-3.5 text-emerald-400" />
            <span>افزودن آی‌پی دلخواه</span>
          </button>
        </div>
      </div>

      {/* Add Custom IP inline form */}
      {showAddModal && (
        <form onSubmit={handleAddSubmit} className="mb-4 p-3 bg-slate-950 border border-slate-800 rounded-xl flex items-center gap-2">
          <input
            type="text"
            placeholder="مثال: 104.16.200.5"
            value={customIpInput}
            onChange={(e) => setCustomIpInput(e.target.value)}
            className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white placeholder:text-slate-500 font-mono focus:outline-none focus:border-sky-500"
          />
          <button
            type="submit"
            className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-medium transition"
          >
            ثبت و انتخاب
          </button>
          <button
            type="button"
            onClick={() => setShowAddModal(false)}
            className="px-2 py-1.5 text-slate-400 hover:text-slate-200 text-xs transition"
          >
            انصراف
          </button>
        </form>
      )}

      {/* Clean IPs List */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {cleanIps.map((item) => {
          const isSelected = item.ip === selectedIp;

          return (
            <div
              key={item.id}
              onClick={() => onSelectIp(item.ip)}
              className={`p-3.5 rounded-xl border transition cursor-pointer flex items-center justify-between gap-3 ${
                isSelected
                  ? 'bg-sky-950/40 border-sky-500/60 shadow-md shadow-sky-950/40'
                  : 'bg-slate-950/70 border-slate-800/80 hover:border-slate-700'
              }`}
            >
              {/* Left Details */}
              <div className="flex items-center gap-3">
                <div className={`w-4 h-4 rounded-full flex items-center justify-center border transition ${
                  isSelected ? 'border-sky-400 bg-sky-400' : 'border-slate-600'
                }`}>
                  {isSelected && <Check className="w-2.5 h-2.5 text-slate-950 font-bold" />}
                </div>

                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs sm:text-sm font-semibold text-white">
                      {item.ip}
                    </span>
                    {item.recommended && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-950/70 text-amber-400 border border-amber-800/50 font-medium">
                        پیشنهادی
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 text-[11px] text-slate-400 mt-0.5">
                    <MapPin className="w-3 h-3 text-slate-500" />
                    <span>{item.location}</span>
                  </div>
                </div>
              </div>

              {/* Right: Latency & Test button */}
              <div className="flex items-center gap-2 shrink-0">
                {item.status === 'testing' ? (
                  <span className="text-[11px] text-sky-400 flex items-center gap-1 font-mono">
                    <RefreshCw className="w-3 h-3 animate-spin" />
                    <span>تست...</span>
                  </span>
                ) : item.latency !== null ? (
                  <span className={`text-[11px] font-mono px-2 py-0.5 rounded border font-semibold ${
                    item.latency < 120 
                      ? 'bg-emerald-950/60 text-emerald-300 border-emerald-800/60' 
                      : item.latency < 250 
                        ? 'bg-amber-950/60 text-amber-300 border-amber-800/60' 
                        : 'bg-rose-950/60 text-rose-300 border-rose-800/60'
                  }`}>
                    {item.latency} ms
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onTestIp(item);
                    }}
                    className="text-[11px] px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 transition"
                  >
                    تست پینگ
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

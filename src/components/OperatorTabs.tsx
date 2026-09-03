import React from 'react';
import { OperatorType } from '../types';
import { Smartphone, Wifi, Radio, Globe } from 'lucide-react';

interface OperatorTabsProps {
  activeTab: OperatorType;
  onSelectTab: (tab: OperatorType) => void;
}

export const OperatorTabs: React.FC<OperatorTabsProps> = ({ activeTab, onSelectTab }) => {
  const tabs: { id: OperatorType; title: string; subtitle: string; icon: any; color: string }[] = [
    {
      id: 'irancell',
      title: 'ایرانسل',
      subtitle: 'Irancell / MTN',
      icon: Smartphone,
      color: '#f59e0b'
    },
    {
      id: 'mci',
      title: 'همراه اول',
      subtitle: 'MCI (Hamrah Aval)',
      icon: Radio,
      color: '#06b6d4'
    },
    {
      id: 'asiatech',
      title: 'آسیاتک',
      subtitle: 'Asiatech ADSL / VDSL',
      icon: Wifi,
      color: '#6366f1'
    },
    {
      id: 'other',
      title: 'سایر اپراتورها',
      subtitle: 'رایتل، مخابرات، شاتل',
      icon: Globe,
      color: '#10b981'
    }
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 sm:gap-3 mb-6">
      {tabs.map((tab) => {
        const isActive = activeTab === tab.id;
        const Icon = tab.icon;

        return (
          <button
            key={tab.id}
            id={`tab-operator-${tab.id}`}
            onClick={() => onSelectTab(tab.id)}
            className={`p-3 sm:p-4 rounded-xl border text-right transition flex items-center gap-3 relative overflow-hidden ${
              isActive
                ? 'bg-slate-900 border-slate-700 shadow-lg'
                : 'bg-slate-950/60 border-slate-800/80 hover:bg-slate-900/60 text-slate-400'
            }`}
          >
            {/* Active accent bar */}
            {isActive && (
              <div 
                className="absolute top-0 right-0 left-0 h-1"
                style={{ backgroundColor: tab.color }}
              />
            )}

            <div 
              className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 transition ${
                isActive ? 'text-white' : 'bg-slate-800 text-slate-400'
              }`}
              style={{ backgroundColor: isActive ? tab.color : undefined }}
            >
              <Icon className="w-5 h-5" />
            </div>

            <div className="min-w-0">
              <div className={`text-xs sm:text-sm font-bold truncate ${isActive ? 'text-white' : 'text-slate-300'}`}>
                {tab.title}
              </div>
              <div className="text-[10px] sm:text-[11px] text-slate-500 truncate">
                {tab.subtitle}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
};

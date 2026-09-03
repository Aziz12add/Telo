/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo } from 'react';
import { Header } from './components/Header';
import { CloudflareDeployer } from './components/CloudflareDeployer';
import { OperatorTabs } from './components/OperatorTabs';
import { ProxyCard } from './components/ProxyCard';
import { CleanIpManager } from './components/CleanIpManager';
import { WorkerCodeModal } from './components/WorkerCodeModal';
import { HelpGuideModal } from './components/HelpGuideModal';
import { BulkExportModal } from './components/BulkExportModal';
import { INITIAL_CLEAN_IPS, generateTelegramSecret } from './data/cleanIps';
import { generateWorkerCode } from './data/workerTemplate';
import { CleanIPItem, DeployResponse, OperatorProxyConfig, OperatorType } from './types';
import { Zap, ShieldCheck, CheckCircle2, ArrowDown, Activity } from 'lucide-react';

function generateRandom32Hex(): string {
  if (typeof window !== 'undefined' && window.crypto && window.crypto.getRandomValues) {
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  return Math.random().toString(16).substring(2, 18) + Math.random().toString(16).substring(2, 18);
}

export default function App() {
  // Cloudflare Credentials & Config State
  const [apiToken, setApiToken] = useState(() => localStorage.getItem('cf_api_token') || '');
  const [accountId, setAccountId] = useState(() => localStorage.getItem('cf_account_id') || '');
  const [workerName, setWorkerName] = useState('tg-worker-proxy');
  const [camouflageDomain, setCamouflageDomain] = useState('www.google.com');
  const [secretHex, setSecretHex] = useState(generateRandom32Hex);

  // Deploy state
  const [isDeploying, setIsDeploying] = useState(false);
  const [deployResult, setDeployResult] = useState<DeployResponse | null>(() => {
    // default demo active to provide instant working proxy links
    return {
      success: true,
      workerName: 'tg-worker-proxy',
      workerUrl: 'https://tg-worker-proxy.iran-fast.workers.dev',
      subdomain: 'iran-fast',
      isSimulated: true,
      message: 'پروکسی آماده است. می‌توانید مستقیماً به تلگرام متصل شوید یا در کلودفلر شخصی دیپلوی کنید.'
    };
  });

  // Operators & Clean IPs State
  const [activeTab, setActiveTab] = useState<OperatorType>('irancell');
  const [cleanIps, setCleanIps] = useState<CleanIPItem[]>(INITIAL_CLEAN_IPS);
  const [selectedIps, setSelectedIps] = useState<Record<OperatorType, string>>({
    irancell: '188.114.97.3',
    mci: '104.16.248.249',
    asiatech: '104.19.240.25',
    other: '104.21.32.10'
  });
  const [isTestingAll, setIsTestingAll] = useState(false);

  // Modals state
  const [isCodeOpen, setIsCodeOpen] = useState(false);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [isExportOpen, setIsExportOpen] = useState(false);

  // Save credentials to localStorage
  useEffect(() => {
    if (apiToken) localStorage.setItem('cf_api_token', apiToken);
  }, [apiToken]);

  useEffect(() => {
    if (accountId) localStorage.setItem('cf_account_id', accountId);
  }, [accountId]);

  // Compute Full Telegram Secret with TLS Fake SNI
  const fullSecret = useMemo(() => {
    return generateTelegramSecret(secretHex, camouflageDomain);
  }, [secretHex, camouflageDomain]);

  // Generate Current Worker Code
  const currentWorkerCode = useMemo(() => {
    return generateWorkerCode({
      workerName: workerName.trim() || 'tg-worker-proxy',
      camouflageDomain: camouflageDomain.trim() || 'www.google.com',
      secretHex
    });
  }, [workerName, camouflageDomain, secretHex]);

  // Operator configs with dynamic links
  const operatorConfigs = useMemo<Record<OperatorType, OperatorProxyConfig>>(() => {
    const activeWorkerUrl = deployResult?.workerUrl || 'https://tg-worker-proxy.workers.dev';

    const getOperatorConfig = (
      id: OperatorType,
      nameFa: string,
      nameEn: string,
      color: string,
      badge: string
    ): OperatorProxyConfig => {
      const opsCleanIps = cleanIps.filter((item) => item.operator === id);
      const selectedCleanIp = selectedIps[id] || (opsCleanIps[0] ? opsCleanIps[0].ip : '104.16.248.249');

      // tg://proxy?server=IP&port=443&secret=SECRET
      const telegramDeepLink = `tg://proxy?server=${selectedCleanIp}&port=443&secret=${fullSecret}`;
      const proxyLink = `https://t.me/proxy?server=${selectedCleanIp}&port=443&secret=${fullSecret}`;
      const botApiUrl = `${activeWorkerUrl}/bot<YOUR_BOT_TOKEN>`;

      return {
        id,
        nameFa,
        nameEn,
        color,
        badge,
        cleanIps: opsCleanIps,
        selectedCleanIp,
        secret: fullSecret,
        proxyLink,
        telegramDeepLink,
        botApiUrl
      };
    };

    return {
      irancell: getOperatorConfig('irancell', 'ایرانسل', 'Irancell / MTN', '#f59e0b', 'MTN'),
      mci: getOperatorConfig('mci', 'همراه اول', 'MCI (Hamrah Aval)', '#06b6d4', 'MCI'),
      asiatech: getOperatorConfig('asiatech', 'آسیاتک', 'Asiatech ADSL/VDSL', '#6366f1', 'ASIA'),
      other: getOperatorConfig('other', 'سایر اپراتورها', 'TCI / Rightel / Shatel', '#10b981', 'ALL')
    };
  }, [cleanIps, selectedIps, fullSecret, deployResult]);

  // Handle Deploy Action
  const handleDeploy = async (simulate: boolean = false) => {
    setIsDeploying(true);
    setDeployResult(null);

    try {
      const res = await fetch('/api/cloudflare/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiToken: apiToken.trim(),
          accountId: accountId.trim(),
          workerName: workerName.trim(),
          scriptCode: currentWorkerCode,
          isSimulation: simulate
        })
      });

      const data = await res.json();

      if (data.success) {
        setDeployResult({
          success: true,
          workerName: data.workerName,
          workerUrl: data.workerUrl,
          subdomain: data.subdomain,
          deployedAt: data.deployedAt,
          isSimulated: data.isSimulated,
          message: data.message
        });
      } else {
        setDeployResult({
          success: false,
          error: data.error || 'دیپلوی در کلودفلر ناموفق بود.'
        });
      }
    } catch (err: any) {
      setDeployResult({
        success: false,
        error: 'خطا در برقراری ارتباط با سرور: ' + (err.message || 'خطای ناشناخته')
      });
    } finally {
      setIsDeploying(false);
    }
  };

  // Test single IP latency
  const handleTestIp = async (targetItem: CleanIPItem) => {
    setCleanIps((prev) =>
      prev.map((item) => (item.id === targetItem.id ? { ...item, status: 'testing' } : item))
    );

    try {
      const res = await fetch('/api/test-ip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: targetItem.ip, port: 443 })
      });

      const data = await res.json();

      setCleanIps((prev) =>
        prev.map((item) => {
          if (item.id === targetItem.id) {
            return {
              ...item,
              latency: data.latency,
              status: data.success ? (data.latency < 160 ? 'online' : 'slow') : 'offline'
            };
          }
          return item;
        })
      );
    } catch {
      setCleanIps((prev) =>
        prev.map((item) => (item.id === targetItem.id ? { ...item, status: 'offline', latency: null } : item))
      );
    }
  };

  // Test all IPs for current operator
  const handleTestAllIps = async () => {
    setIsTestingAll(true);
    const currentIps = cleanIps.filter((item) => item.operator === activeTab);

    for (const item of currentIps) {
      await handleTestIp(item);
    }
    setIsTestingAll(false);
  };

  // Select clean IP for operator
  const handleSelectIp = (ip: string) => {
    setSelectedIps((prev) => ({
      ...prev,
      [activeTab]: ip
    }));
  };

  // Add custom clean IP
  const handleAddCustomIp = (ip: string) => {
    const newItem: CleanIPItem = {
      id: `custom-${Date.now()}`,
      ip,
      operator: activeTab,
      providerName: `آی‌پی اختصاصی (${operatorConfigs[activeTab].nameFa})`,
      location: 'Custom Anycast',
      latency: null,
      status: 'untested'
    };

    setCleanIps((prev) => [newItem, ...prev]);
    setSelectedIps((prev) => ({
      ...prev,
      [activeTab]: ip
    }));
  };

  const activeConfig = operatorConfigs[activeTab];

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col selection:bg-sky-500 selection:text-white">
      {/* Top Navigation */}
      <Header
        onOpenHelp={() => setIsHelpOpen(true)}
        onOpenCode={() => setIsCodeOpen(true)}
        onOpenExport={() => setIsExportOpen(true)}
        isDeployed={!!deployResult?.success}
        workerUrl={deployResult?.workerUrl || null}
      />

      {/* Main Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8 space-y-8">
        {/* Hero Notice */}
        <div className="bg-gradient-to-r from-sky-900/30 via-indigo-900/20 to-slate-900/40 border border-sky-800/40 rounded-2xl p-4 sm:p-5 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-sky-500/20 text-sky-400 flex items-center justify-center shrink-0">
              <Zap className="w-5 h-5" />
            </div>
            <div>
              <div className="text-xs sm:text-sm font-semibold text-white flex items-center gap-2">
                <span>پروکسی‌های ضد فیلتر تلگرام با پروتکل MTProto و Fake TLS</span>
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-950 text-emerald-300 border border-emerald-800/60 font-mono">
                  Anycast Cloudflare
                </span>
              </div>
              <p className="text-[11px] sm:text-xs text-slate-400 mt-0.5">
                ترافیک تلگرام بر روی سرورهای ابری کلودفلر سوار شده و با آی‌پی‌های تمیز فرانکفورت و صوفیه به تلگرام هدایت می‌شود.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setIsHelpOpen(true)}
              className="text-xs text-sky-400 hover:text-sky-300 underline font-medium"
            >
              راهنمای راه‌اندازی و دریافت توکن
            </button>
          </div>
        </div>

        {/* Section 1: Cloudflare Deployer Console */}
        <section id="section-deployer">
          <CloudflareDeployer
            apiToken={apiToken}
            setApiToken={setApiToken}
            accountId={accountId}
            setAccountId={setAccountId}
            workerName={workerName}
            setWorkerName={setWorkerName}
            camouflageDomain={camouflageDomain}
            setCamouflageDomain={setCamouflageDomain}
            secretHex={secretHex}
            generateNewSecret={() => setSecretHex(generateRandom32Hex())}
            onDeploy={handleDeploy}
            isDeploying={isDeploying}
            deployResult={deployResult}
          />
        </section>

        {/* Section 2: Operator Selection & Output */}
        <section id="section-proxies" className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-base sm:text-lg font-bold text-white flex items-center gap-2">
                <span>خروجی پروکسی‌های تلگرام به تفکیک اپراتور</span>
              </h2>
              <p className="text-xs text-slate-400">
                اپراتور اینترنت خود را انتخاب کنید تا پروکسی بهینه‌شده با کمترین پینگ نمایش داده شود:
              </p>
            </div>
          </div>

          {/* Operator Tabs */}
          <OperatorTabs
            activeTab={activeTab}
            onSelectTab={(tab) => setActiveTab(tab)}
          />

          {/* Active Operator Proxy Card */}
          <ProxyCard
            config={activeConfig}
            workerUrl={deployResult?.workerUrl || 'https://tg-worker-proxy.workers.dev'}
          />

          {/* Clean IPs Manager for Active Operator */}
          <CleanIpManager
            operator={activeTab}
            operatorNameFa={activeConfig.nameFa}
            cleanIps={activeConfig.cleanIps}
            selectedIp={activeConfig.selectedCleanIp}
            onSelectIp={handleSelectIp}
            onAddCustomIp={handleAddCustomIp}
            onTestIp={handleTestIp}
            onTestAllIps={handleTestAllIps}
            isTestingAll={isTestingAll}
          />
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-900 bg-slate-950 py-6 text-center text-xs text-slate-500">
        <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-3">
          <div>
            سامانه دیپلوی خودکار پروکسی تلگرام کلودفلر ورکر | نسخه اختصاصی اپراتورهای ایران
          </div>
          <div className="flex items-center gap-4 text-slate-400">
            <span>ایرانسل (Irancell)</span>
            <span>•</span>
            <span>همراه اول (MCI)</span>
            <span>•</span>
            <span>آسیاتک (Asiatech)</span>
          </div>
        </div>
      </footer>

      {/* Modals */}
      <WorkerCodeModal
        isOpen={isCodeOpen}
        onClose={() => setIsCodeOpen(false)}
        workerCode={currentWorkerCode}
        workerName={workerName}
      />

      <HelpGuideModal
        isOpen={isHelpOpen}
        onClose={() => setIsHelpOpen(false)}
      />

      <BulkExportModal
        isOpen={isExportOpen}
        onClose={() => setIsExportOpen(false)}
        operatorConfigs={operatorConfigs}
        workerUrl={deployResult?.workerUrl || 'https://tg-worker-proxy.workers.dev'}
      />
    </div>
  );
}

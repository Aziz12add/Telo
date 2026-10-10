export interface CloudflareCredentials {
  apiToken: string;
  accountId: string;
  workerName: string;
  proxySecret: string;
  customHostname?: string;
}

export interface CloudflareAccount {
  id: string;
  name: string;
}

export interface DeployResponse {
  success: boolean;
  workerName?: string;
  workerUrl?: string;
  subdomain?: string;
  secret?: string;
  message?: string;
  error?: string;
  deployedAt?: string;
  isSimulated?: boolean;
}

export type OperatorType = 'irancell' | 'mci' | 'asiatech' | 'other';

export interface CleanIPItem {
  id: string;
  ip: string;
  operator: OperatorType;
  providerName: string;
  asn?: string;
  location: string;
  latency: number | null;
  status: 'untested' | 'testing' | 'online' | 'slow' | 'offline';
  recommended?: boolean;
}

export interface OperatorProxyConfig {
  id: OperatorType;
  nameFa: string;
  nameEn: string;
  color: string;
  badge: string;
  cleanIps: CleanIPItem[];
  selectedCleanIp: string;
  secret: string;
  proxyLink: string;
  telegramDeepLink: string;
  healthUrl: string;
  protocolBadge: string;
}

export interface CloudflareWorkerScript {
  id: string;
  created_on: string;
  modified_on: string;
}

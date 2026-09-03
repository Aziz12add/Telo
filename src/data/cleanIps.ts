import { CleanIPItem } from '../types';

export const INITIAL_CLEAN_IPS: CleanIPItem[] = [
  // همراه اول (MCI)
  {
    id: 'mci-1',
    ip: '104.16.248.249',
    operator: 'mci',
    providerName: 'همراه اول (MCI)',
    location: 'Cloudflare Edge (Frankfurt)',
    latency: null,
    status: 'untested',
    recommended: true,
  },
  {
    id: 'mci-2',
    ip: '172.67.180.120',
    operator: 'mci',
    providerName: 'همراه اول (MCI)',
    location: 'Cloudflare Edge (Amsterdam)',
    latency: null,
    status: 'untested',
    recommended: true,
  },
  {
    id: 'mci-3',
    ip: '104.21.45.180',
    operator: 'mci',
    providerName: 'همراه اول (MCI)',
    location: 'Cloudflare Anycast (Vienna)',
    latency: null,
    status: 'untested',
  },
  {
    id: 'mci-4',
    ip: '162.159.192.1',
    operator: 'mci',
    providerName: 'همراه اول (MCI)',
    location: 'Cloudflare Edge (Istanbul)',
    latency: null,
    status: 'untested',
  },
  {
    id: 'mci-5',
    ip: '104.18.22.52',
    operator: 'mci',
    providerName: 'همراه اول (MCI)',
    location: 'Cloudflare Edge (Dubai)',
    latency: null,
    status: 'untested',
  },

  // ایرانسل (Irancell)
  {
    id: 'irancell-1',
    ip: '188.114.97.3',
    operator: 'irancell',
    providerName: 'ایرانسل (Irancell)',
    location: 'Cloudflare Edge (Frankfurt)',
    latency: null,
    status: 'untested',
    recommended: true,
  },
  {
    id: 'irancell-2',
    ip: '104.22.40.100',
    operator: 'irancell',
    providerName: 'ایرانسل (Irancell)',
    location: 'Cloudflare Edge (Sofia)',
    latency: null,
    status: 'untested',
    recommended: true,
  },
  {
    id: 'irancell-3',
    ip: '188.114.96.2',
    operator: 'irancell',
    providerName: 'ایرانسل (Irancell)',
    location: 'Cloudflare Anycast (Amsterdam)',
    latency: null,
    status: 'untested',
  },
  {
    id: 'irancell-4',
    ip: '104.26.12.18',
    operator: 'irancell',
    providerName: 'ایرانسل (Irancell)',
    location: 'Cloudflare Edge (Milan)',
    latency: null,
    status: 'untested',
  },
  {
    id: 'irancell-5',
    ip: '172.67.70.150',
    operator: 'irancell',
    providerName: 'ایرانسل (Irancell)',
    location: 'Cloudflare Edge (Frankfurt)',
    latency: null,
    status: 'untested',
  },

  // آسیاتک (Asiatech)
  {
    id: 'asiatech-1',
    ip: '104.19.240.25',
    operator: 'asiatech',
    providerName: 'آسیاتک (Asiatech)',
    location: 'Cloudflare Edge (Frankfurt)',
    latency: null,
    status: 'untested',
    recommended: true,
  },
  {
    id: 'asiatech-2',
    ip: '198.41.214.162',
    operator: 'asiatech',
    providerName: 'آسیاتک (Asiatech)',
    location: 'Cloudflare Edge (London)',
    latency: null,
    status: 'untested',
    recommended: true,
  },
  {
    id: 'asiatech-3',
    ip: '104.18.35.120',
    operator: 'asiatech',
    providerName: 'آسیاتک (Asiatech)',
    location: 'Cloudflare Anycast (Paris)',
    latency: null,
    status: 'untested',
  },
  {
    id: 'asiatech-4',
    ip: '172.67.140.20',
    operator: 'asiatech',
    providerName: 'آسیاتک (Asiatech)',
    location: 'Cloudflare Edge (Stockholm)',
    latency: null,
    status: 'untested',
  },

  // سایر (مخابرات، رایتل و ...)
  {
    id: 'other-1',
    ip: '104.21.32.10',
    operator: 'other',
    providerName: 'مخابرات و رایتل',
    location: 'Cloudflare Edge (Frankfurt)',
    latency: null,
    status: 'untested',
    recommended: true,
  },
  {
    id: 'other-2',
    ip: '172.67.200.5',
    operator: 'other',
    providerName: 'شاتل و های‌وب',
    location: 'Cloudflare Edge (Amsterdam)',
    latency: null,
    status: 'untested',
  }
];

export function stringToHex(str: string): string {
  let hex = '';
  for (let i = 0; i < str.length; i++) {
    const charCode = str.charCodeAt(i).toString(16);
    hex += charCode.padStart(2, '0');
  }
  return hex;
}

export function generateTelegramSecret(baseSecretHex: string, camouflageDomain: string): string {
  // Telegram TLS secret format: 'ee' + 32-hex-secret + hex(domain)
  const cleanBase = baseSecretHex.replace(/^ee/, '').slice(0, 32).padEnd(32, '0');
  const domainHex = stringToHex(camouflageDomain.trim().toLowerCase());
  return `ee${cleanBase}${domainHex}`;
}

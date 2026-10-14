// Telegram datacenter endpoints (IPv4). These can change over time; treat them
// as defaults and refresh from https://core.telegram.org/getProxyConfig or your
// own config if connections to a DC start failing.
export const DC_ADDRESSES: Record<number, string> = {
  1: '149.154.175.50',
  2: '149.154.167.51',
  3: '149.154.175.100',
  4: '149.154.167.91',
  5: '91.108.56.130',
};

export const DC_PORT = 443;

/**
 * The init packet carries an int16 DC id (negative = media DC).
 * Returns 1..5, or null for anything else (test DCs, CDN DCs, garbage).
 */
export const resolveDc = (raw: number): number | null => {
  const id = Math.abs(raw);
  return id >= 1 && id <= 5 ? id : null;
};

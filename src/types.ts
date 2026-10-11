export interface CloudflareAccount {
  id: string;
  name: string;
}

export interface WebProxyDeployResult {
  hostname: string;
  secret: string;
  tmeLink: string;
  tgLink: string;
}

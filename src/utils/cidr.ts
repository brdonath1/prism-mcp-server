/**
 * Lightweight CIDR range checker.
 * No external dependencies — pure bit math.
 */

function ipToLong(ip: string): number {
  const parts = ip.split(".").map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function parseCidr(cidr: string): { network: number; mask: number } {
  const [ip, prefixStr] = cidr.split("/");
  const prefix = parseInt(prefixStr, 10);
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  const network = ipToLong(ip) & mask;
  return { network, mask };
}

export function isIpInCidr(ip: string, cidr: string): boolean {
  try {
    const ipLong = ipToLong(ip);
    const { network, mask } = parseCidr(cidr);
    return (ipLong & mask) === network;
  } catch {
    return false;
  }
}

export function isIpInAnyCidr(ip: string, cidrs: string[]): boolean {
  return cidrs.some(cidr => isIpInCidr(ip, cidr));
}

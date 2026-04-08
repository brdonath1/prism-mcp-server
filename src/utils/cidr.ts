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

/**
 * Normalize an IP address for comparison.
 * Strips IPv6-mapped IPv4 prefix (::ffff:) so that addresses like
 * ::ffff:160.79.104.1 are correctly matched against IPv4 CIDR ranges.
 */
function normalizeIp(ip: string): string {
  // Handle IPv6-mapped IPv4: ::ffff:A.B.C.D
  const v4Mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4Mapped) return v4Mapped[1];
  return ip;
}

export function isIpInCidr(ip: string, cidr: string): boolean {
  try {
    const normalizedIp = normalizeIp(ip);

    // Pure IPv6 addresses (after normalization) — not yet supported.
    // Return false gracefully; add full IPv6 CIDR support if needed.
    if (normalizedIp.includes(":") || cidr.includes(":")) {
      return false;
    }

    const ipLong = ipToLong(normalizedIp);
    const { network, mask } = parseCidr(cidr);
    return (ipLong & mask) === network;
  } catch {
    return false;
  }
}

export function isIpInAnyCidr(ip: string, cidrs: string[]): boolean {
  return cidrs.some(cidr => isIpInCidr(ip, cidr));
}

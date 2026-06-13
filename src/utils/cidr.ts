/**
 * Lightweight CIDR range checker.
 * No external dependencies — pure bit math.
 */

function ipToLong(ip: string): number {
  const parts = ip.split(".");
  // SRV-26: reject malformed IPv4 outright. Without octet validation an
  // out-of-range octet (e.g. 999, or 256) overflows the byte and bleeds into
  // the adjacent octet — a malformed address could then spuriously match a
  // different range. Callers wrap this in try/catch (-> false), so throwing is
  // the right signal for "not a valid IPv4".
  if (parts.length !== 4) {
    throw new Error(`invalid IPv4 address: ${ip}`);
  }
  let long = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      throw new Error(`invalid IPv4 octet: ${ip}`);
    }
    const octet = Number(part);
    if (octet > 255) {
      throw new Error(`IPv4 octet out of range (0-255): ${ip}`);
    }
    long = (long << 8) | octet;
  }
  return long >>> 0;
}

function parseCidr(cidr: string): { network: number; mask: number } {
  const [ip, prefixStr] = cidr.split("/");
  const prefix = Number(prefixStr);
  // SRV-26: a prefix outside 0–32 MUST be rejected. JavaScript's `<<` takes
  // the shift count mod 32, so without this guard `32 - prefix` wraps for
  // prefix > 32 — a `/33` typo silently becomes a `/1` mask (0x80000000) and
  // widens an operator-supplied allowlist to ~1 billion addresses with no
  // error. Number() (not parseInt) also rejects trailing-garbage prefixes
  // like "33abc". Caller's try/catch turns the throw into a clean `false`.
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`invalid CIDR prefix (must be an integer 0-32): ${cidr}`);
  }
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

import { Resolver } from "dns/promises";
import { BlockList, isIP } from "net";

const blockedV4 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blockedV4.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const blockedV6 = new BlockList();
for (const [address, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) {
  blockedV6.addSubnet(address, prefix, "ipv6");
}

export function integrationBoundaryError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

export function isPublicIntegrationAddress(address: string): boolean {
  if (address.includes("%")) return false;
  const family = isIP(address);
  if (family === 4) return !blockedV4.check(address, "ipv4");
  // Also excludes mapped IPv4, NAT64, loopback, unspecified, ULA, link-local and multicast.
  return family === 6 && globalV6.check(address, "ipv6") && !blockedV6.check(address, "ipv6");
}

export function validateIntegrationUrl(url: string, providerCode: string): URL {
  let target: URL;
  try { target = new URL(url); } catch { throw integrationBoundaryError("EDESTINATION", "Invalid integration destination"); }
  const hostname = target.hostname.replace(/^\[|\]$/g, "");
  if (target.protocol !== "https:" || target.username || target.password || target.hash ||
      (target.port && target.port !== "443") || !hostname || hostname.endsWith(".") ||
      (isIP(hostname) ? !isPublicIntegrationAddress(hostname) :
        (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname)))) {
    throw integrationBoundaryError("EDESTINATION", "Integration destination is not permitted");
  }
  if (!/^[a-z0-9_-]{1,64}$/i.test(providerCode)) throw integrationBoundaryError("EDESTINATION", "Invalid provider destination policy");
  const policyKey = `INTEGRATION_HTTP_ALLOWED_ORIGINS_${providerCode.toUpperCase().replace(/-/g, "_")}`;
  const configured = String(process.env[policyKey] ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  const permitted = configured.some((value) => {
    try {
      const approved = new URL(value);
      return approved.protocol === "https:" && !approved.username && !approved.password && !approved.search && !approved.hash &&
        approved.pathname === "/" && approved.origin === target.origin;
    } catch { return false; }
  });
  if (!permitted) throw integrationBoundaryError("EDESTINATION", "Integration origin is not server-allowlisted for this provider");
  return target;
}

export type PinnedDestination = { address: string; family: 4 | 6 };

export async function resolveIntegrationDestination(hostname: string, signal: AbortSignal): Promise<PinnedDestination> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (signal.aborted) throw integrationBoundaryError("ETIMEDOUT", "Integration request timed out");
  if (isIP(host)) {
    if (!isPublicIntegrationAddress(host)) throw integrationBoundaryError("EDESTINATION", "Integration address is not public");
    return { address: host, family: isIP(host) as 4 | 6 };
  }
  const resolver = new Resolver({ timeout: 1000, tries: 1 });
  const cancel = () => resolver.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(cancel, 1500);
  try {
    const answers = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
    if (signal.aborted) throw integrationBoundaryError("ETIMEDOUT", "Integration request timed out");
    const addresses: PinnedDestination[] = [];
    for (let index = 0; index < answers.length; index++) {
      const answer = answers[index];
      if (answer.status === "rejected") {
        if (!["ENODATA", "ENOTFOUND"].includes(answer.reason?.code)) throw integrationBoundaryError("EDNS", "Integration DNS resolution failed or timed out");
      } else {
        for (const address of answer.value) addresses.push({ address, family: index === 0 ? 4 : 6 });
      }
    }
    if (!addresses.length || addresses.length > 16 || addresses.some((item) => isIP(item.address) !== item.family || !isPublicIntegrationAddress(item.address))) {
      throw integrationBoundaryError("EDESTINATION", "Integration DNS answers are not permitted");
    }
    return addresses[0];
  } finally {
    clearTimeout(timer); signal.removeEventListener("abort", cancel); resolver.cancel();
  }
}

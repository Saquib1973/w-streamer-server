import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { env } from "../config/env.js";
import { AppError } from "./errors.js";

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["224.0.0.0", 4],
] as const)
  blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::1", 128],
  ["::", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  // NOTE: don't add ::ffff:0:0/96 — Node's BlockList matches every IPv4 address against it.
  // IPv4-mapped IPv6 addresses are unwrapped and checked as IPv4 instead.
] as const)
  blocked.addSubnet(net, prefix, "ipv6");

/**
 * Rejects URLs that resolve to private / loopback / link-local addresses
 * (unless ALLOW_LAN_ADDONS=true — useful for self-hosted addons on your LAN).
 */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError("VALIDATION_FAILED", "Invalid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new AppError("VALIDATION_FAILED", "Only http(s) URLs are allowed");
  if (url.username || url.password) throw new AppError("VALIDATION_FAILED", "Credentials in URL are not allowed");
  if (env.ALLOW_LAN_ADDONS) return url;

  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true }).catch(() => []);
  if (addrs.length === 0) throw new AppError("ADDON_UNREACHABLE", `Cannot resolve host ${host}`);
  for (const a of addrs) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a.address);
    const [addr, fam] = mapped ? [mapped[1]!, "ipv4" as const] : [a.address, a.family === 6 ? ("ipv6" as const) : ("ipv4" as const)];
    if (blocked.check(addr, fam))
      throw new AppError("FORBIDDEN", "Private/LAN addresses are blocked (set ALLOW_LAN_ADDONS=true to allow)");
  }
  return url;
}

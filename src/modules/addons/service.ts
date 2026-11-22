import type { Addon, Prisma } from "@prisma/client";
import { LRUCache } from "lru-cache";
import { env } from "../../config/env.js";
import type { AddonValidationDto, VaultProvider } from "../../contracts/api.js";
import { AddonManifest, type ManifestResource } from "../../contracts/stremio.js";
import { prisma } from "../../db/prisma.js";
import { audit } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { fetchJson } from "../../lib/http-client.js";
import type { ParentalPolicy } from "../../lib/maturity.js";
import { assertPublicUrl } from "../../lib/ssrf.js";
import { getSecret } from "../vault/service.js";

export const BUILTIN_ADDONS = [
  { url: "https://v3-cinemeta.strem.io/manifest.json", protected: true },
  { url: "https://opensubtitles-v3.strem.io/manifest.json", protected: false },
] as const;

/* ─────────── URL handling ─────────── */

/** Accepts stremio://, base URLs, or full manifest URLs → https://…/manifest.json */
export function normalizeTransportUrl(input: string): string {
  let s = input.trim();
  if (s.startsWith("stremio://")) s = "https://" + s.slice("stremio://".length);
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  const u = new URL(s);
  u.hash = "";
  if (!u.pathname.endsWith("/manifest.json")) u.pathname = u.pathname.replace(/\/+$/, "") + "/manifest.json";
  // URL() percent-encodes "{" / "}" — restore vault placeholders like {{TORBOX}} so they still match.
  return u.toString().replace(/%7B%7B([A-Z_]+)%7D%7D/gi, (_m, name: string) => `{{${name.toUpperCase()}}}`);
}

/**
 * Vault placeholders: a stored transportUrl may contain {{REAL_DEBRID}}, {{TORBOX}},
 * {{ALLDEBRID}}, {{TMDB}}, {{OPENSUBTITLES}} — substituted at request time so
 * secrets never live in the addons table.
 */
const PLACEHOLDER_RE = /\{\{(REAL_DEBRID|TORBOX|ALLDEBRID|TMDB|OPENSUBTITLES)\}\}/g;

/** Torrentio-style config segment keys per debrid provider. */
const TORRENTIO_KEYS: Record<"REAL_DEBRID" | "TORBOX" | "ALLDEBRID", string> = {
  REAL_DEBRID: "realdebrid",
  TORBOX: "torbox",
  ALLDEBRID: "alldebrid",
};

export async function materializeUrl(ownerId: string, transportUrl: string, injectVault: boolean): Promise<string> {
  let url = transportUrl;
  const needed = [...new Set([...url.matchAll(PLACEHOLDER_RE)].map((m) => m[1] as VaultProvider))];
  for (const p of needed) {
    const s = await getSecret(ownerId, p);
    if (!s) throw new AppError("VAULT_SECRET_MISSING", `Addon needs a ${p} token in the vault`);
    url = url.replaceAll(`{{${p}}}`, encodeURIComponent(s.secret));
  }
  if (injectVault && needed.length === 0) url = await injectTorrentioStyle(ownerId, url);
  return url;
}

/** For Torrentio-compatible addons: append `|realdebrid=KEY` to the config segment if no debrid is configured. */
async function injectTorrentioStyle(ownerId: string, url: string): Promise<string> {
  const u = new URL(url);
  const parts = u.pathname.split("/").filter(Boolean); // [config?, "manifest.json"]
  const config = parts.length >= 2 ? decodeURIComponent(parts[parts.length - 2]!) : "";
  if (/(realdebrid|torbox|alldebrid|premiumize|debridlink)=/i.test(config)) return url;
  for (const p of ["REAL_DEBRID", "TORBOX", "ALLDEBRID"] as const) {
    const s = await getSecret(ownerId, p);
    if (!s) continue;
    const seg = `${TORRENTIO_KEYS[p]}=${s.secret}`;
    const newConfig = config ? `${config}|${seg}` : seg;
    const base = parts.length >= 2 ? parts.slice(0, -2) : parts.slice(0, -1);
    u.pathname = "/" + [...base, encodeURIComponent(newConfig), "manifest.json"].join("/");
    return u.toString();
  }
  return url;
}

export const baseOf = (manifestUrl: string) => manifestUrl.replace(/\/manifest\.json(\?.*)?$/, "");

/* ─────────── Manifest fetch & validation ─────────── */

export async function fetchManifest(url: string): Promise<AddonManifest> {
  await assertPublicUrl(url);
  const raw = await fetchJson(url, { timeoutMs: 6000, label: "Addon manifest" });
  const parsed = AddonManifest.safeParse(raw);
  if (!parsed.success)
    throw new AppError("ADDON_INVALID_MANIFEST", "That URL didn't return a valid Stremio manifest", parsed.error.issues.slice(0, 5));
  return parsed.data;
}

const resourceName = (r: ManifestResource) => (typeof r === "string" ? r : r.name);

export async function validateAddon(ownerId: string, input: string): Promise<AddonValidationDto> {
  const transportUrl = normalizeTransportUrl(input);
  const manifest = await fetchManifest(await materializeUrl(ownerId, transportUrl, false));
  const warnings: string[] = [];
  const bh = manifest.behaviorHints;
  if (bh?.configurationRequired) warnings.push("configurationRequired");
  if (bh?.adult) warnings.push("adult");
  if (bh?.p2p) warnings.push("p2p");
  if (!manifest.resources.length) warnings.push("noResources");
  const existing = await prisma.addon.findUnique({ where: { userId_transportUrl: { userId: ownerId, transportUrl } } });
  return { transportUrl, manifest, warnings, alreadyInstalled: !!existing };
}

function addonColumns(m: AddonManifest) {
  return {
    manifestId: m.id,
    name: m.name.slice(0, 120),
    version: m.version.slice(0, 40),
    description: m.description ?? null,
    logo: m.logo?.slice(0, 1024) ?? null,
    manifest: m as unknown as Prisma.InputJsonValue,
    resources: [...new Set(m.resources.map(resourceName))],
    types: m.types,
    idPrefixes: m.idPrefixes ?? [],
    isAdult: !!m.behaviorHints?.adult,
    lastValidatedAt: new Date(),
    lastError: null,
  };
}

export async function installAddon(ownerId: string, input: string, opts: { injectVault?: boolean; isProtected?: boolean; policy?: ParentalPolicy; profileId?: string } = {}) {
  const v = await validateAddon(ownerId, input);
  if (v.alreadyInstalled) throw new AppError("CONFLICT", "Addon is already installed");
  if (opts.policy?.restricted && opts.policy.hideAdultAddons && v.manifest.behaviorHints?.adult)
    throw new AppError("CONTENT_RESTRICTED", "Adult addons are blocked for this profile");
  const max = await prisma.addon.aggregate({ where: { userId: ownerId }, _max: { sortOrder: true } });
  const addon = await prisma.addon.create({
    data: {
      userId: ownerId,
      transportUrl: v.transportUrl,
      ...addonColumns(v.manifest),
      injectVault: opts.injectVault ?? false,
      isProtected: opts.isProtected ?? false,
      sortOrder: (max._max.sortOrder ?? -1) + 1,
    },
  });
  // A child installing an addon gets it on their own allowlist.
  if (opts.policy?.restricted && opts.profileId) await prisma.profileAddon.create({ data: { profileId: opts.profileId, addonId: addon.id } });
  audit("ADDON_INSTALLED", { userId: ownerId, meta: { name: addon.name, manifestId: addon.manifestId } });
  return addon;
}

export async function refreshAddon(addon: Addon) {
  try {
    const m = await fetchManifest(await materializeUrl(addon.userId, addon.transportUrl, false));
    return prisma.addon.update({ where: { id: addon.id }, data: addonColumns(m) });
  } catch (e) {
    await prisma.addon.update({ where: { id: addon.id }, data: { lastError: e instanceof Error ? e.message.slice(0, 500) : "refresh failed" } });
    throw e;
  }
}

export async function installBuiltinAddons(ownerId: string) {
  for (const b of BUILTIN_ADDONS) {
    try {
      await installAddon(ownerId, b.url, { isProtected: b.protected });
    } catch (e) {
      if (!(e instanceof AppError && e.code === "CONFLICT")) throw e;
    }
  }
}

/* ─────────── Visibility (parental) ─────────── */

export async function visibleAddons(ownerId: string, policy: ParentalPolicy, profileId: string): Promise<Addon[]> {
  const addons = await prisma.addon.findMany({ where: { userId: ownerId, enabled: true }, orderBy: { sortOrder: "asc" } });
  if (!policy.restricted) return addons;
  let allowed: Set<string> | null = null;
  if (policy.addonAllowlistOnly) {
    const rows = await prisma.profileAddon.findMany({ where: { profileId, allowed: true }, select: { addonId: true } });
    allowed = new Set(rows.map((r) => r.addonId));
  }
  return addons.filter((a) => (!policy.hideAdultAddons || !a.isAdult) && (allowed === null || allowed.has(a.id) || a.isProtected));
}

/* ─────────── Resource calls ─────────── */

export type Resource = "catalog" | "meta" | "stream" | "subtitles";

export function supports(addon: Addon, resource: Resource, type: string, id?: string): boolean {
  const m = addon.manifest as unknown as AddonManifest;
  for (const r of m.resources) {
    if (resourceName(r) !== resource) continue;
    const types = typeof r === "string" ? m.types : (r.types ?? m.types);
    const prefixes = typeof r === "string" ? m.idPrefixes : (r.idPrefixes ?? m.idPrefixes);
    if (!types.includes(type)) continue;
    if (id && prefixes?.length && !prefixes.some((p) => id.startsWith(p))) continue;
    return true;
  }
  return false;
}

const TTL: Record<Resource, number> = { catalog: 10 * 60_000, meta: 30 * 60_000, stream: 5 * 60_000, subtitles: 30 * 60_000 };
const responseCache = new LRUCache<string, object>({ max: 2000, ttlAutopurge: false });

/** GET {base}/{resource}/{type}/{id}[/{extra}].json with caching + timeout. */
export async function callAddon<T extends object>(addon: Addon, resource: Resource, type: string, id: string, extra?: Record<string, string | number | undefined>): Promise<T> {
  const url = baseOf(await materializeUrl(addon.userId, addon.transportUrl, addon.injectVault));
  const extraStr = extra
    ? Object.entries(extra)
        .filter(([, v]) => v !== undefined && v !== "")
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join("&")
    : "";
  const full = `${url}/${resource}/${encodeURIComponent(type)}/${encodeURIComponent(id)}${extraStr ? "/" + extraStr : ""}.json`;
  const hit = responseCache.get(full);
  if (hit) return hit as T;
  const data = await fetchJson<T>(full, { timeoutMs: env.ADDON_TIMEOUT_MS, label: addon.name });
  if (!data || typeof data !== "object") throw new AppError("ADDON_UNREACHABLE", `${addon.name}: empty response`);
  responseCache.set(full, data, { ttl: TTL[resource] });
  return data;
}

/** Runs fn over addons in parallel, collecting successes and failures (never throws). */
export async function fanOut<T>(addons: Addon[], fn: (a: Addon) => Promise<T>) {
  const settled = await Promise.allSettled(addons.map(fn));
  const ok: { addon: Addon; value: T }[] = [];
  const failures: { addonId: string; addonName: string; error: string }[] = [];
  settled.forEach((r, i) => {
    const addon = addons[i]!;
    if (r.status === "fulfilled") ok.push({ addon, value: r.value });
    else failures.push({ addonId: addon.id, addonName: addon.name, error: r.reason instanceof Error ? r.reason.message : "failed" });
  });
  return { ok, failures };
}

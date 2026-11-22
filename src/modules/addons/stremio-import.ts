import type { ImportStremioResultDto } from "../../contracts/api.js";
import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/errors.js";
import { fetchJson, UpstreamHttpError } from "../../lib/http-client.js";
import { logger } from "../../lib/logger.js";
import { installAddon, normalizeTransportUrl } from "./service.js";

const STREMIO_API = "https://api.strem.io/api";

interface StremioEnvelope<T> {
  result?: T;
  error?: { message?: string; code?: number } | string;
}
interface StremioCollectionAddon {
  transportUrl: string;
  manifest?: { id?: string; name?: string; [k: string]: unknown };
  flags?: { official?: boolean; protected?: boolean };
}

const errText = (e: StremioEnvelope<unknown>["error"]) => (typeof e === "string" ? e : (e?.message ?? "Stremio API error"));

async function stremioCall<T>(method: string, body: Record<string, unknown>): Promise<T> {
  let r: StremioEnvelope<T>;
  try {
    r = await fetchJson<StremioEnvelope<T>>(`${STREMIO_API}/${method}`, { method: "POST", body: { type: method[0]!.toUpperCase() + method.slice(1), ...body }, timeoutMs: 15_000, label: "Stremio" });
  } catch (e) {
    if (e instanceof UpstreamHttpError) throw new AppError("ADDON_UNREACHABLE", "Couldn't reach Stremio's servers");
    throw e;
  }
  if (r.error || !r.result) {
    const msg = errText(r.error);
    if (/password|user|credential|wrong|not found/i.test(msg)) throw new AppError("INVALID_CREDENTIALS", "Stremio rejected that email or password");
    throw new AppError("ADDON_UNREACHABLE", `Stremio: ${msg}`);
  }
  return r.result;
}

/** Local-only addons (Stremio desktop's streaming server) can't work from a phone. */
const isLocal = (url: string) => /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)[:/]/i.test(url);

/**
 * Logs in to Stremio, reads the account's addon collection in order, installs every
 * addon that isn't already installed, and logs out. Credentials are never persisted.
 */
export async function importFromStremio(ownerId: string, email: string, password: string, skipExisting: boolean): Promise<ImportStremioResultDto> {
  const login = await stremioCall<{ authKey: string }>("login", { email, password, facebook: false });
  const authKey = login.authKey;
  const out: ImportStremioResultDto = { imported: [], skipped: [], failed: [] };
  try {
    const col = await stremioCall<{ addons: StremioCollectionAddon[] }>("addonCollectionGet", { authKey, update: true });
    const existing = new Set((await prisma.addon.findMany({ where: { userId: ownerId }, select: { transportUrl: true } })).map((a) => a.transportUrl));

    // Sequential keeps Stremio's order (which becomes our sortOrder) and is gentle on addon hosts.
    for (const a of col.addons ?? []) {
      const name = a.manifest?.name ?? a.transportUrl;
      if (!a.transportUrl) continue;
      if (isLocal(a.transportUrl)) {
        out.skipped.push({ name, reason: "Runs only inside Stremio desktop" });
        continue;
      }
      let url: string;
      try {
        url = normalizeTransportUrl(a.transportUrl);
      } catch {
        out.failed.push({ name, transportUrl: a.transportUrl, error: "Invalid URL" });
        continue;
      }
      if (skipExisting && existing.has(url)) {
        out.skipped.push({ name, reason: "Already installed" });
        continue;
      }
      try {
        const addon = await installAddon(ownerId, url, { fallbackManifest: a.manifest });
        existing.add(url);
        out.imported.push({ name: addon.name, id: addon.id });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Install failed";
        if (e instanceof AppError && e.code === "CONFLICT") out.skipped.push({ name, reason: "Already installed" });
        else out.failed.push({ name, transportUrl: url.replace(/\/[^/]{40,}\//g, "/***/"), error: msg });
      }
    }
  } finally {
    stremioCall("logout", { authKey }).catch((err: unknown) => logger.debug({ err }, "stremio logout failed"));
  }
  return out;
}

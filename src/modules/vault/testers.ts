import type { VaultProvider, VaultTestResultDto } from "../../contracts/api.js";
import { fetchJson, UpstreamHttpError } from "../../lib/http-client.js";

type Tester = (secret: string, meta: Record<string, unknown> | null) => Promise<Record<string, unknown>>;

const bearer = (s: string) => ({ authorization: `Bearer ${s}` });

const testers: Partial<Record<VaultProvider, Tester>> = {
  async TMDB(secret) {
    // v4 read-access tokens are JWTs; v3 keys are 32-hex.
    const isV4 = secret.startsWith("eyJ");
    const url = isV4 ? "https://api.themoviedb.org/3/configuration" : `https://api.themoviedb.org/3/configuration?api_key=${encodeURIComponent(secret)}`;
    await fetchJson(url, { headers: isV4 ? bearer(secret) : {}, errorCode: "VAULT_SECRET_MISSING", label: "TMDB" });
    return { tokenType: isV4 ? "v4 read token" : "v3 api key" };
  },
  async REAL_DEBRID(secret) {
    const u = await fetchJson<{ username: string; type: string; expiration: string; points: number }>(
      "https://api.real-debrid.com/rest/1.0/user",
      { headers: bearer(secret), errorCode: "DEBRID_ERROR", label: "Real-Debrid" },
    );
    return { username: u.username, premium: u.type === "premium", premiumUntil: u.expiration, points: u.points };
  },
  async TORBOX(secret) {
    const r = await fetchJson<{ success: boolean; data: { email?: string; plan?: number; premium_expires_at?: string } }>(
      "https://api.torbox.app/v1/api/user/me",
      { headers: bearer(secret), errorCode: "DEBRID_ERROR", label: "TorBox" },
    );
    if (!r.success) throw new Error("TorBox rejected the token");
    return { email: r.data.email ?? null, plan: r.data.plan ?? null, premiumUntil: r.data.premium_expires_at ?? null };
  },
  async ALLDEBRID(secret) {
    const r = await fetchJson<{ status: string; data?: { user: { username: string; isPremium: boolean; premiumUntil: number } }; error?: { message: string } }>(
      "https://api.alldebrid.com/v4/user?agent=wstreamer",
      { headers: bearer(secret), errorCode: "DEBRID_ERROR", label: "AllDebrid" },
    );
    if (r.status !== "success" || !r.data) throw new Error(r.error?.message ?? "AllDebrid rejected the token");
    const u = r.data.user;
    return { username: u.username, premium: u.isPremium, premiumUntil: u.premiumUntil ? new Date(u.premiumUntil * 1000).toISOString() : null };
  },
  async OPENSUBTITLES(secret) {
    await fetchJson("https://api.opensubtitles.com/api/v1/infos/formats", {
      headers: { "api-key": secret, "user-agent": "W-Streamer v0.1" },
      errorCode: "VAULT_SECRET_MISSING",
      label: "OpenSubtitles",
    });
    return { status: "api key valid" };
  },
};

export const canTest = (p: VaultProvider) => p in testers;

export async function testSecret(provider: VaultProvider, secret: string, meta: Record<string, unknown> | null): Promise<VaultTestResultDto> {
  const t = testers[provider];
  if (!t) return { ok: true, provider, account: { note: "No live check available for this provider" } };
  try {
    return { ok: true, provider, account: await t(secret, meta) };
  } catch (e) {
    const status = e instanceof UpstreamHttpError ? e.upstreamStatus : null;
    const msg = status === 401 || status === 403 ? "Token rejected by provider" : e instanceof Error ? e.message : "Check failed";
    return { ok: false, provider, error: msg };
  }
}

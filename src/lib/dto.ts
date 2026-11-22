import type { Addon, LibraryItem, Profile, User, VaultSecret, WatchProgress } from "@prisma/client";
import type {
  AddonDto,
  LastStreamRef,
  LibraryItemDto,
  ProfileDto,
  UserDto,
  VaultEntryDto,
  WatchProgressDto,
} from "../contracts/api.js";
import type { AddonManifest } from "../contracts/stremio.js";

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export const toUserDto = (u: User): UserDto => ({
  id: u.id,
  username: u.username,
  email: u.email,
  role: u.role,
  createdAt: u.createdAt.toISOString(),
  lastLoginAt: iso(u.lastLoginAt),
});

export const toProfileDto = (p: Profile): ProfileDto => ({
  id: p.id,
  name: p.name,
  avatar: p.avatar,
  accentColor: p.accentColor,
  kind: p.kind,
  hasPin: !!p.pinHash,
  isLocked: p.isLocked,
  sortOrder: p.sortOrder,
  parental:
    p.kind === "CHILD"
      ? {
          maturityCap: p.maturityCap,
          hideUnrated: p.hideUnrated,
          hideAdultAddons: p.hideAdultAddons,
          allowMagnetInput: p.allowMagnetInput,
          allowAddonInstall: p.allowAddonInstall,
          addonAllowlistOnly: p.addonAllowlistOnly,
        }
      : null,
  preferences: {
    preferredAudioLang: p.preferredAudioLang,
    preferredSubLang: p.preferredSubLang,
    autoplayNext: p.autoplayNext,
  },
});

export const toVaultEntryDto = (v: VaultSecret): VaultEntryDto => ({
  id: v.id,
  provider: v.provider,
  label: v.label,
  hint: v.hint,
  meta: (v.meta as Record<string, unknown> | null) ?? null,
  isActive: v.isActive,
  lastUsedAt: iso(v.lastUsedAt),
  lastCheckAt: iso(v.lastCheckAt),
  lastCheckOk: v.lastCheckOk,
  updatedAt: v.updatedAt.toISOString(),
});

/** Strips secrets embedded in configured addon URLs (Torrentio-style config segments, query keys). */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    for (const k of [...u.searchParams.keys()]) if (/key|token|secret|pass|auth/i.test(k)) u.searchParams.set(k, "***");
    u.pathname = u.pathname
      .split("/")
      .map((seg) => (/(realdebrid|torbox|alldebrid|premiumize|debridlink|apikey|token)[=_-]/i.test(decodeURIComponent(seg)) || seg.length > 80 ? "***" : seg))
      .join("/");
    return u.toString();
  } catch {
    return "***";
  }
}

export const toAddonDto = (a: Addon): AddonDto => {
  const m = a.manifest as unknown as AddonManifest;
  return {
    id: a.id,
    transportUrl: redactUrl(a.transportUrl),
    manifest: {
      id: m.id,
      name: m.name,
      version: m.version,
      description: m.description,
      logo: m.logo,
      types: m.types,
      catalogs: m.catalogs ?? [],
      behaviorHints: m.behaviorHints,
    },
    resources: a.resources,
    types: a.types,
    isAdult: a.isAdult,
    isProtected: a.isProtected,
    enabled: a.enabled,
    sortOrder: a.sortOrder,
    injectVault: a.injectVault,
    lastValidatedAt: iso(a.lastValidatedAt),
    lastError: a.lastError,
  };
};

export const toLibraryItemDto = (l: LibraryItem): LibraryItemDto => ({
  metaId: l.metaId,
  type: l.type,
  name: l.name,
  poster: l.poster,
  background: l.background,
  year: l.year,
  certification: l.certification,
  inWatchlist: l.inWatchlist,
  watched: l.watched,
  lastWatchedAt: iso(l.lastWatchedAt),
  addedAt: l.addedAt.toISOString(),
});

export const toProgressDto = (w: WatchProgress): WatchProgressDto => ({
  metaId: w.metaId,
  videoId: w.videoId,
  type: w.type,
  season: w.season,
  episode: w.episode,
  positionSec: w.positionSec,
  durationSec: w.durationSec,
  completed: w.completed,
  lastStream: (w.lastStream as LastStreamRef | null) ?? null,
  audioTrack: w.audioTrack,
  subtitleLang: w.subtitleLang,
  subtitleDelayMs: w.subtitleDelayMs,
  updatedAt: w.updatedAt.toISOString(),
});

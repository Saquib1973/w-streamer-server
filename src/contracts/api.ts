/**
 * W-Streamer REST API contract — v1.
 *
 * Single source of truth for request validation (zod) and response DTOs.
 * The Expo client consumes this file via `npm run contracts:sync` (copies
 * src/contracts → wstreamer-app/src/api/contracts). Keep it dependency-free
 * except for zod.
 */
import { z } from "zod";
import type { AddonManifest, AddonStream, AddonSubtitle, MetaDetail, MetaPreview } from "./stremio.js";

export const API_PREFIX = "/api/v1" as const;

/* ═══════════════════════ Shared primitives ═══════════════════════ */

export const UserRole = z.enum(["ADMIN", "CHILD"]);
export type UserRole = z.infer<typeof UserRole>;

export const ProfileKind = z.enum(["OWNER", "CHILD"]);
export type ProfileKind = z.infer<typeof ProfileKind>;

export const MaturityRating = z.enum(["G", "PG", "PG_13", "R", "NC_17"]);
export type MaturityRating = z.infer<typeof MaturityRating>;
/** Ordinal used for cap comparisons: allowed ⇔ RANK[content] <= RANK[cap]. */
export const MATURITY_RANK: Record<MaturityRating, number> = { G: 0, PG: 1, PG_13: 2, R: 3, NC_17: 4 };

export const VaultProvider = z.enum([
  "TMDB",
  "REAL_DEBRID",
  "TORBOX",
  "ALLDEBRID",
  "OPENSUBTITLES",
  "TRAKT",
  "CUSTOM_TRACKER",
  "CUSTOM_INDEXER",
]);
export type VaultProvider = z.infer<typeof VaultProvider>;
export const DEBRID_PROVIDERS = ["REAL_DEBRID", "TORBOX", "ALLDEBRID"] as const satisfies readonly VaultProvider[];
export type DebridProvider = (typeof DEBRID_PROVIDERS)[number];

export const MediaType = z.enum(["movie", "series", "channel", "tv", "other"]);
export type MediaType = z.infer<typeof MediaType>;

const Uuid = z.string().uuid();
const Pin = z.string().regex(/^\d{4}$/, "PIN must be exactly 4 digits");
const Password = z.string().min(10, "Min 10 characters").max(256);
const Username = z
  .string()
  .min(3)
  .max(32)
  .regex(/^[a-zA-Z0-9_.-]+$/, "Letters, numbers, _ . - only");
const InfoHash = z.string().regex(/^[a-fA-F0-9]{40}$/, "40-char hex info hash");

/* ═══════════════════════ Errors ═══════════════════════ */

export const ErrorCode = z.enum([
  "VALIDATION_FAILED",
  "UNAUTHENTICATED",
  "TOKEN_EXPIRED",
  "FORBIDDEN",
  "PROFILE_REQUIRED",
  "PIN_REQUIRED",
  "PIN_INVALID",
  "PIN_LOCKED",
  "ACCOUNT_LOCKED",
  "INVALID_CREDENTIALS",
  "REGISTRATION_LOCKED",
  "NOT_FOUND",
  "CONFLICT",
  "RATE_LIMITED",
  "ADDON_UNREACHABLE",
  "ADDON_INVALID_MANIFEST",
  "VAULT_SECRET_MISSING",
  "DEBRID_ERROR",
  "TORRENT_METADATA_TIMEOUT",
  "TORRENT_LIMIT_REACHED",
  "CONTENT_RESTRICTED",
  "INTERNAL",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** Every non-2xx response has this body. */
export interface ApiError {
  error: {
    code: ErrorCode;
    message: string;
    /** zod issues for VALIDATION_FAILED; other structured detail otherwise */
    details?: unknown;
    requestId: string;
  };
}

/** Cursor pagination envelope. */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/* ═══════════════════════ JWT claims ═══════════════════════ */

/** Access token (HS256, 15 min). Sent as `Authorization: Bearer <jwt>`. */
export interface AccessTokenClaims {
  sub: string; // userId
  role: UserRole;
  /** Active profile. Absent until a profile is selected → most routes return PROFILE_REQUIRED. */
  pid?: string;
  pkind?: ProfileKind;
  /** User.tokenVersion — mismatch ⇒ token revoked. */
  tv: number;
  iat: number;
  exp: number;
  typ: "access";
}

/** Short-lived token embedded in stream URLs (players can't always send headers). */
export interface StreamTokenClaims {
  sub: string; // userId
  pid: string; // profileId
  /** "torrent:<infoHash>:<fileIdx>" | "proxy:<sha256(url)>" */
  res: string;
  exp: number;
  typ: "stream";
}

export interface TokenPair {
  accessToken: string;
  accessTokenExpiresAt: string; // ISO
  refreshToken: string; // opaque 256-bit, base64url
  refreshTokenExpiresAt: string;
}

/* ═══════════════════════ DTOs ═══════════════════════ */

export interface UserDto {
  id: string;
  username: string;
  email: string | null;
  role: UserRole;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface ParentalControlsDto {
  maturityCap: MaturityRating;
  hideUnrated: boolean;
  hideAdultAddons: boolean;
  allowMagnetInput: boolean;
  allowAddonInstall: boolean;
  addonAllowlistOnly: boolean;
}

export interface ProfileDto {
  id: string;
  name: string;
  avatar: string | null;
  accentColor: string | null;
  kind: ProfileKind;
  hasPin: boolean;
  isLocked: boolean;
  sortOrder: number;
  /** Present for CHILD profiles; null for OWNER. */
  parental: ParentalControlsDto | null;
  preferences: {
    preferredAudioLang: string | null;
    preferredSubLang: string | null;
    autoplayNext: boolean;
  };
}

export interface ChildAccountDto {
  user: UserDto;
  profile: ProfileDto;
}

export interface VaultEntryDto {
  id: string;
  provider: VaultProvider;
  label: string;
  hint: string; // "…a9F2" — the secret itself is NEVER returned
  meta: Record<string, unknown> | null;
  isActive: boolean;
  lastUsedAt: string | null;
  lastCheckAt: string | null;
  lastCheckOk: boolean | null;
  updatedAt: string;
}

export interface VaultTestResultDto {
  ok: boolean;
  provider: VaultProvider;
  /** e.g. { username, premiumUntil, points } for debrid; { status } for TMDB */
  account?: Record<string, unknown>;
  error?: string;
}

export interface AddonDto {
  id: string;
  transportUrl: string; // secrets inside configured URLs are redacted in responses
  manifest: Pick<AddonManifest, "id" | "name" | "version" | "description" | "logo" | "types" | "catalogs" | "behaviorHints">;
  resources: string[];
  types: string[];
  isAdult: boolean;
  isProtected: boolean;
  enabled: boolean;
  sortOrder: number;
  injectVault: boolean;
  lastValidatedAt: string | null;
  lastError: string | null;
}

export interface AddonValidationDto {
  transportUrl: string;
  manifest: AddonManifest;
  warnings: string[]; // "configurationRequired", "p2p", "adult", …
  alreadyInstalled: boolean;
}

/** Board / Discover row. */
export interface CatalogRowDto {
  key: string; // "<addonId>:<type>:<catalogId>"
  addonId: string;
  addonName: string;
  type: string;
  catalogId: string;
  title: string;
  items: MetaPreviewDto[];
  hasMore: boolean;
}

export type MetaPreviewDto = MetaPreview & {
  certification?: MaturityRating | null;
  inLibrary?: boolean;
  progress?: { positionSec: number; durationSec: number } | null;
};

export type MetaDetailDto = MetaDetail & {
  certification: MaturityRating | null;
  sourceAddonId: string;
  library: { inWatchlist: boolean; watched: boolean } | null;
  /** keyed by videoId */
  progress: Record<string, { positionSec: number; durationSec: number; completed: boolean }>;
  nextVideoId: string | null;
};

/* ─── Streams ─── */

export type StreamKind = "debrid" | "torrent" | "http" | "youtube" | "external";

export interface ParsedStreamInfo {
  resolution: "2160p" | "1440p" | "1080p" | "720p" | "480p" | "unknown";
  hdr: ("HDR10" | "HDR10+" | "DV" | "HLG")[];
  codec: "HEVC" | "AVC" | "AV1" | "VP9" | "unknown";
  audio: string[]; // "Atmos", "DTS-HD MA", "TrueHD", "DDP5.1", "AAC"
  sizeBytes: number | null;
  seeders: number | null;
  releaseGroup: string | null;
  container: "mkv" | "mp4" | "webm" | "unknown";
}

export interface StreamOptionDto {
  /** Stable id for the picker: sha1(addonId + raw stream) */
  id: string;
  addonId: string;
  addonName: string;
  kind: StreamKind;
  title: string; // cleaned display title
  description: string | null;
  info: ParsedStreamInfo;
  infoHash: string | null;
  fileIdx: number | null;
  /** Debrid cache state per configured provider; omitted when no debrid tokens in vault. */
  debridCached: Partial<Record<DebridProvider, boolean>> | null;
  /** Raw addon stream for passthrough to /resolve */
  raw: AddonStream;
  subtitles: AddonSubtitle[];
  bingeGroup: string | null;
}

export interface StreamListDto {
  type: string;
  videoId: string;
  streams: StreamOptionDto[];
  /** Addons that failed/timed out — UI shows a non-blocking notice. */
  failures: { addonId: string; addonName: string; error: string }[];
}

export interface ResolvedStreamDto {
  kind: StreamKind;
  /** Playable URL. For torrent/proxy kinds this is our server URL with ?st=<stream token>. */
  url: string;
  /** Extra headers the player must send (e.g. addon proxyHeaders). */
  headers: Record<string, string> | null;
  expiresAt: string | null;
  filename: string | null;
  sizeBytes: number | null;
  mimeType: string | null;
  /** Hint for the player: MKV/HEVC/DTS need the native (VLC/MPV) backend. */
  requiresNativePlayer: boolean;
  provider: DebridProvider | "p2p" | "direct";
  torrent: { infoHash: string; fileIdx: number } | null;
}

/* ─── Torrent engine ─── */

export interface TorrentFileDto {
  index: number;
  name: string;
  path: string;
  sizeBytes: number;
  isVideo: boolean;
  /** Parsed from filename for season packs. */
  season: number | null;
  episode: number | null;
}

export interface TorrentInfoDto {
  infoHash: string;
  name: string;
  totalBytes: number;
  files: TorrentFileDto[];
  /** Index of the most likely main video (largest video file). */
  suggestedFileIdx: number | null;
  stats: TorrentStatsDto;
}

export interface TorrentStatsDto {
  peers: number;
  downloadSpeed: number; // bytes/s
  uploadSpeed: number;
  progress: number; // 0..1 overall
  downloadedBytes: number;
  /** Readahead buffer for the active file (sequential window), 0..1 */
  bufferHealth: number | null;
  state: "fetching_metadata" | "ready" | "streaming" | "idle" | "destroyed";
}

/* ─── Library & progress ─── */

export interface LibraryItemDto {
  metaId: string;
  type: MediaType;
  name: string;
  poster: string | null;
  background: string | null;
  year: string | null;
  certification: MaturityRating | null;
  inWatchlist: boolean;
  watched: boolean;
  lastWatchedAt: string | null;
  addedAt: string;
}

export interface WatchProgressDto {
  metaId: string;
  videoId: string;
  type: MediaType;
  season: number | null;
  episode: number | null;
  positionSec: number;
  durationSec: number;
  completed: boolean;
  lastStream: LastStreamRef | null;
  audioTrack: string | null;
  subtitleLang: string | null;
  subtitleDelayMs: number;
  updatedAt: string;
}

export interface ContinueWatchingItemDto {
  meta: Pick<MetaPreview, "id" | "type" | "name" | "poster" | "background">;
  progress: WatchProgressDto;
  /** If the last episode was completed, the next one to play. */
  upNext: { videoId: string; season: number; episode: number; title: string | null } | null;
}

export const LastStreamRef = z.object({
  kind: z.enum(["debrid", "torrent", "http", "youtube", "external"]),
  addonId: z.string().optional(),
  infoHash: InfoHash.optional(),
  fileIdx: z.number().int().nonnegative().optional(),
  url: z.string().url().optional(),
});
export type LastStreamRef = z.infer<typeof LastStreamRef>;

/* ═══════════════════════ Request bodies ═══════════════════════ */

/* ─── Auth ─── */

export const RegisterAdminBody = z.object({
  setupToken: z.string().min(16),
  username: Username,
  email: z.string().email().optional(),
  password: Password,
  /** PIN for the OWNER profile, used to exit child profiles. */
  ownerPin: Pin,
  deviceName: z.string().max(80).optional(),
});
export type RegisterAdminBody = z.infer<typeof RegisterAdminBody>;

export const LoginBody = z.object({
  /** username or email */
  identifier: z.string().min(3).max(254),
  password: z.string().min(1).max(256),
  deviceName: z.string().max(80).optional(),
});
export type LoginBody = z.infer<typeof LoginBody>;

export const RefreshBody = z.object({ refreshToken: z.string().min(32) });
export type RefreshBody = z.infer<typeof RefreshBody>;

export const ChangePasswordBody = z.object({ currentPassword: z.string(), newPassword: Password });
export type ChangePasswordBody = z.infer<typeof ChangePasswordBody>;

/* ─── Profiles ─── */

const ParentalControlsInput = z.object({
  maturityCap: MaturityRating,
  hideUnrated: z.boolean(),
  hideAdultAddons: z.boolean(),
  allowMagnetInput: z.boolean(),
  allowAddonInstall: z.boolean(),
  addonAllowlistOnly: z.boolean(),
});

export const CreateProfileBody = z.object({
  name: z.string().trim().min(1).max(40),
  avatar: z.string().max(255).optional(),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/).optional(),
  /** Sub-profiles under the admin are always CHILD; OWNER is created at registration. */
  parental: ParentalControlsInput.partial().optional(),
  pin: Pin.optional(),
});
export type CreateProfileBody = z.infer<typeof CreateProfileBody>;

export const UpdateProfileBody = CreateProfileBody.partial().extend({
  isLocked: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
  preferences: z
    .object({
      preferredAudioLang: z.string().max(8).nullable(),
      preferredSubLang: z.string().max(8).nullable(),
      autoplayNext: z.boolean(),
    })
    .partial()
    .optional(),
});
export type UpdateProfileBody = z.infer<typeof UpdateProfileBody>;

export const SelectProfileBody = z.object({
  /** Required for any PIN-protected profile (the OWNER profile always has one). */
  pin: Pin.optional(),
  /** Current refresh token — revoked so the previous profile session can't be resumed. */
  refreshToken: z.string().min(32).optional(),
  deviceName: z.string().max(80).optional(),
});
export type SelectProfileBody = z.infer<typeof SelectProfileBody>;

export const SetPinBody = z.object({
  /** Admin's account password re-confirms sensitive change. */
  password: z.string().min(1),
  pin: Pin.nullable(), // null clears PIN (not allowed for OWNER)
});
export type SetPinBody = z.infer<typeof SetPinBody>;

export const ProfileAddonAccessBody = z.object({
  allow: z.array(Uuid),
});
export type ProfileAddonAccessBody = z.infer<typeof ProfileAddonAccessBody>;

/* ─── Child accounts (standalone CHILD logins) ─── */

export const CreateChildAccountBody = z.object({
  username: Username,
  password: Password,
  profile: CreateProfileBody,
});
export type CreateChildAccountBody = z.infer<typeof CreateChildAccountBody>;

export const UpdateChildAccountBody = z.object({
  password: Password.optional(),
  isLocked: z.boolean().optional(),
  profile: UpdateProfileBody.optional(),
});
export type UpdateChildAccountBody = z.infer<typeof UpdateChildAccountBody>;

/* ─── Vault ─── */

export const PutVaultSecretBody = z.object({
  label: z.string().trim().min(1).max(60).default("default"),
  secret: z.string().min(1).max(8192),
  /** Non-secret metadata, e.g. { baseUrl } for custom indexers. */
  meta: z.record(z.string(), z.unknown()).optional(),
  isActive: z.boolean().default(true),
  /** Validate against provider before saving. */
  testBeforeSave: z.boolean().default(true),
});
export type PutVaultSecretBody = z.infer<typeof PutVaultSecretBody>;

/* ─── Addons ─── */

export const AddonUrlBody = z.object({
  /** Accepts https://…/manifest.json, stremio://…/manifest.json, or base URL. */
  transportUrl: z.string().min(8).max(1024),
});
export type AddonUrlBody = z.infer<typeof AddonUrlBody>;

export const InstallAddonBody = AddonUrlBody.extend({
  injectVault: z.boolean().default(false),
});
export type InstallAddonBody = z.infer<typeof InstallAddonBody>;

export const UpdateAddonBody = z.object({
  enabled: z.boolean().optional(),
  injectVault: z.boolean().optional(),
});
export type UpdateAddonBody = z.infer<typeof UpdateAddonBody>;

/** One-time import of a Stremio account's addon collection. Credentials are used once and never stored. */
export const ImportStremioBody = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(256),
  /** Skip addons whose URL is already installed (default true). */
  skipExisting: z.boolean().default(true),
});
export type ImportStremioBody = z.infer<typeof ImportStremioBody>;

export interface ImportStremioResultDto {
  imported: { name: string; id: string }[];
  skipped: { name: string; reason: string }[];
  failed: { name: string; transportUrl: string; error: string }[];
}

export const ReorderAddonsBody = z.object({ ids: z.array(Uuid).min(1) });
export type ReorderAddonsBody = z.infer<typeof ReorderAddonsBody>;

/* ─── Catalog ─── */

export const CatalogQuery = z.object({
  skip: z.coerce.number().int().min(0).optional(),
  genre: z.string().max(64).optional(),
  search: z.string().max(200).optional(),
});
export type CatalogQuery = z.infer<typeof CatalogQuery>;

export const SearchQuery = z.object({
  q: z.string().trim().min(1).max(200),
  type: MediaType.optional(),
});
export type SearchQuery = z.infer<typeof SearchQuery>;

export const StreamsQuery = z.object({
  /** Only return debrid-cached results when a debrid token exists. */
  cachedOnly: z.coerce.boolean().optional(),
  maxResolution: z.enum(["2160p", "1080p", "720p"]).optional(),
});
export type StreamsQuery = z.infer<typeof StreamsQuery>;

export const ResolveStreamBody = z.object({
  /** Either an addon stream (from StreamOptionDto.raw) or a direct torrent ref. */
  source: z.union([
    z.object({ type: z.literal("addon"), addonId: Uuid, stream: z.record(z.string(), z.unknown()) }),
    z.object({ type: z.literal("torrent"), infoHash: InfoHash, fileIdx: z.number().int().nonnegative() }),
  ]),
  /** "auto" = first debrid provider with cache hit → otherwise P2P. */
  prefer: z.enum(["auto", "p2p", "REAL_DEBRID", "TORBOX", "ALLDEBRID"]).default("auto"),
  /** For season packs: pick the file matching this episode. */
  hint: z.object({ season: z.number().int().optional(), episode: z.number().int().optional() }).optional(),
});
export type ResolveStreamBody = z.infer<typeof ResolveStreamBody>;

/* ─── Torrents (direct magnet / .torrent input) ─── */

export const AddTorrentBody = z
  .object({
    magnet: z
      .string()
      .startsWith("magnet:?", "Must be a magnet: URI")
      .max(8192)
      .optional(),
    infoHash: InfoHash.optional(),
    /** base64 .torrent file (multipart also accepted on the same route) */
    torrentFileBase64: z.string().max(4_000_000).optional(),
  })
  .refine((b) => [b.magnet, b.infoHash, b.torrentFileBase64].filter(Boolean).length === 1, {
    message: "Provide exactly one of magnet, infoHash, torrentFileBase64",
  });
export type AddTorrentBody = z.infer<typeof AddTorrentBody>;

/* ─── Library & progress ─── */

export const UpsertLibraryBody = z.object({
  type: MediaType,
  name: z.string().min(1).max(255),
  poster: z.string().url().max(1024).nullable().optional(),
  background: z.string().url().max(1024).nullable().optional(),
  year: z.string().max(16).nullable().optional(),
  inWatchlist: z.boolean().optional(),
  watched: z.boolean().optional(),
});
export type UpsertLibraryBody = z.infer<typeof UpsertLibraryBody>;

export const PutProgressBody = z.object({
  metaId: z.string().min(1).max(255),
  type: MediaType,
  season: z.number().int().nonnegative().nullable().optional(),
  episode: z.number().int().nonnegative().nullable().optional(),
  positionSec: z.number().nonnegative(),
  durationSec: z.number().nonnegative(),
  lastStream: LastStreamRef.nullable().optional(),
  audioTrack: z.string().max(32).nullable().optional(),
  subtitleLang: z.string().max(8).nullable().optional(),
  subtitleDelayMs: z.number().int().min(-600_000).max(600_000).optional(),
  /** Display info so Continue Watching can render without refetching meta. */
  meta: z
    .object({
      name: z.string().min(1).max(255),
      poster: z.string().max(1024).nullable().optional(),
      background: z.string().max(1024).nullable().optional(),
    })
    .optional(),
});
export type PutProgressBody = z.infer<typeof PutProgressBody>;

/** Server marks completed when positionSec / durationSec >= this. */
export const COMPLETION_THRESHOLD = 0.9;

/* ─── Phone-side stream fetching ─── */

/** An addon the device may query directly for streams (URL has vault keys filled in). */
export interface StreamEndpointDto {
  addonId: string;
  name: string;
  /** Base URL without /manifest.json — request `${baseUrl}/stream/{type}/{id}.json`. */
  baseUrl: string;
}

export const CachedCheckBody = z.object({ hashes: z.array(InfoHash).min(1).max(300) });
export type CachedCheckBody = z.infer<typeof CachedCheckBody>;

/* ─── Analytics (admin) ─── */

export interface AnalyticsUserDto {
  id: string;
  username: string;
  role: UserRole;
  isLocked: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  activeSessions: number;
  watchSeconds: number;
  titlesWatched: number;
  episodesWatched: number;
  lastWatched: { metaId: string; name: string; at: string } | null;
}

export interface AnalyticsDto {
  totals: { users: number; activeLast7d: number; watchSeconds: number; titlesWatched: number; plays: number };
  users: AnalyticsUserDto[];
  recent: { userId: string; username: string; metaId: string; name: string; videoId: string; season: number | null; episode: number | null; positionSec: number; durationSec: number; at: string }[];
  /** Last 14 days, oldest first: seconds watched per day. */
  daily: { day: string; watchSeconds: number }[];
}

/* ═══════════════════════ Response map (route → body) ═══════════════════════ */

export interface ApiResponses {
  "GET /health": { ok: true; version: string; db: "up" | "down"; torrentEngine: "up" | "down" };

  "GET /auth/bootstrap": { registrationOpen: boolean };
  "POST /auth/register-admin": { user: UserDto; profiles: ProfileDto[]; tokens: TokenPair };
  "POST /auth/login": { user: UserDto; profiles: ProfileDto[]; tokens: TokenPair };
  "POST /auth/refresh": { tokens: TokenPair };
  "POST /auth/logout": { ok: true };
  "POST /auth/logout-all": { ok: true; revokedSessions: number };
  "GET /auth/me": { user: UserDto; activeProfile: ProfileDto | null };
  /** All sessions are revoked; this device gets a fresh pair. */
  "POST /auth/change-password": { ok: true; tokens: TokenPair };

  "GET /profiles": { profiles: ProfileDto[] };
  "POST /profiles": { profile: ProfileDto };
  "PATCH /profiles/:id": { profile: ProfileDto };
  "DELETE /profiles/:id": { ok: true };
  "POST /profiles/:id/select": { profile: ProfileDto; tokens: TokenPair };
  "PUT /profiles/:id/pin": { ok: true };
  "GET /profiles/:id/addons": { addons: (AddonDto & { allowed: boolean })[] };
  "PUT /profiles/:id/addons": { ok: true };

  "GET /admin/child-accounts": { accounts: ChildAccountDto[] };
  "POST /admin/child-accounts": { account: ChildAccountDto };
  "PATCH /admin/child-accounts/:userId": { account: ChildAccountDto };
  "DELETE /admin/child-accounts/:userId": { ok: true };
  "GET /admin/audit": Page<{ id: string; action: string; createdAt: string; meta: unknown }>;
  "GET /admin/analytics": AnalyticsDto;
  "GET /addons/stream-endpoints": { endpoints: StreamEndpointDto[] };
  "POST /debrid/cached": { cached: Record<string, Partial<Record<DebridProvider, boolean>>> };

  "GET /vault": { entries: VaultEntryDto[]; providers: VaultProvider[] };
  "PUT /vault/:provider": { entry: VaultEntryDto; test: VaultTestResultDto | null };
  "POST /vault/:id/test": VaultTestResultDto;
  "DELETE /vault/:id": { ok: true };

  "GET /addons": { addons: AddonDto[] };
  "POST /addons/validate": AddonValidationDto;
  "POST /addons": { addon: AddonDto };
  "PATCH /addons/:id": { addon: AddonDto };
  "PUT /addons/order": { addons: AddonDto[] };
  "POST /addons/:id/refresh": { addon: AddonDto };
  "POST /addons/import/stremio": ImportStremioResultDto;
  "DELETE /addons/:id": { ok: true };

  "GET /board": { hero: MetaPreviewDto[]; continueWatching: ContinueWatchingItemDto[]; rows: CatalogRowDto[] };
  "GET /discover": { filters: { addonId: string; type: string; catalogId: string; title: string; genres: string[] }[] };
  "GET /catalog/:addonId/:type/:catalogId": { items: MetaPreviewDto[]; hasMore: boolean };
  "GET /search": { rows: CatalogRowDto[] };
  "GET /meta/:type/:id": { meta: MetaDetailDto };
  "GET /streams/:type/:videoId": StreamListDto;
  "GET /subtitles/:type/:videoId": { subtitles: (AddonSubtitle & { addonName: string })[] };
  "POST /resolve": ResolvedStreamDto;

  "POST /torrents": TorrentInfoDto;
  "GET /torrents/:infoHash": TorrentInfoDto;
  "GET /torrents/:infoHash/stats": TorrentStatsDto;
  "DELETE /torrents/:infoHash": { ok: true };

  "GET /library": Page<LibraryItemDto>;
  "PUT /library/:metaId": { item: LibraryItemDto };
  "DELETE /library/:metaId": { ok: true };
  "GET /progress/continue-watching": { items: ContinueWatchingItemDto[] };
  "GET /progress/:metaId": { items: WatchProgressDto[] };
  "PUT /progress/:videoId": { progress: WatchProgressDto; upNext: ContinueWatchingItemDto["upNext"] };
  "DELETE /progress/:videoId": { ok: true };
}
export type ApiRoute = keyof ApiResponses;

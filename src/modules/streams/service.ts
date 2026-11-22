import { createHash } from "node:crypto";
import type { Addon } from "@prisma/client";
import { env } from "../../config/env.js";
import {
  DEBRID_PROVIDERS,
  type DebridProvider,
  type ResolveStreamBody,
  type ResolvedStreamDto,
  type StreamKind,
  type StreamListDto,
  type StreamOptionDto,
  type StreamsQuery,
} from "../../contracts/api.js";
import { AddonStream, StreamResponse, SubtitlesResponse, type AddonSubtitle } from "../../contracts/stremio.js";
import { AppError, forbidden } from "../../lib/errors.js";
import { signStreamToken } from "../../lib/jwt.js";
import { logger } from "../../lib/logger.js";
import { isAllowed } from "../../lib/maturity.js";
import { mimeForFile, needsNativePlayer, parseEpisode, parseStreamText, scoreStream } from "../../lib/stream-parser.js";
import { callAddon, fanOut, supports, visibleAddons } from "../addons/service.js";
import type { Viewer } from "../catalog/service.js";
import { ADAPTERS } from "../debrid/adapters.js";
import { getRating, metaIdFromVideoId } from "../ratings/service.js";
import { buildMagnet, torrentEngine } from "../torrent/engine.js";
import { getSecret } from "../vault/service.js";

const RES_ORDER = ["480p", "720p", "1080p", "1440p", "2160p"] as const;

async function assertTitleAllowed(v: Viewer, type: string, videoId: string) {
  if (!v.policy.restricted) return;
  const rating = await getRating(v.ownerId, metaIdFromVideoId(type, videoId), type);
  if (!isAllowed(v.policy, rating)) throw new AppError("CONTENT_RESTRICTED", "This title isn't available on this profile");
}

async function debridTokens(ownerId: string) {
  const out: Partial<Record<DebridProvider, string>> = {};
  for (const p of DEBRID_PROVIDERS) {
    const s = await getSecret(ownerId, p);
    if (s) out[p] = s.secret;
  }
  return out;
}

function kindOf(s: AddonStream): StreamKind {
  if (s.infoHash) return "torrent";
  if (s.url) return "http";
  if (s.ytId) return "youtube";
  return "external";
}

const streamId = (addonId: string, s: AddonStream) =>
  createHash("sha1").update(addonId).update(JSON.stringify([s.url, s.infoHash, s.fileIdx, s.ytId, s.externalUrl, s.title, s.name])).digest("hex").slice(0, 20);

function toOption(addon: Addon, s: AddonStream): StreamOptionDto {
  const text = [s.name, s.title, s.description, s.behaviorHints?.filename].filter(Boolean).join("\n");
  const info = parseStreamText(text, s.behaviorHints?.videoSize ?? undefined);
  const title = (s.title ?? s.description ?? s.name ?? "Stream").split("\n")[0]!.trim();
  return {
    id: streamId(addon.id, s),
    addonId: addon.id,
    addonName: addon.name,
    kind: kindOf(s),
    title,
    description: [s.name, s.title ?? s.description].filter(Boolean).join(" · ").replace(/\n+/g, " · ") || null,
    info,
    infoHash: s.infoHash?.toLowerCase() ?? null,
    fileIdx: s.fileIdx ?? null,
    debridCached: null,
    raw: s,
    subtitles: s.subtitles ?? [],
    bingeGroup: s.behaviorHints?.bingeGroup ?? null,
  };
}

export async function listStreams(v: Viewer, type: string, videoId: string, q: StreamsQuery): Promise<StreamListDto> {
  await assertTitleAllowed(v, type, videoId);
  const addons = (await visibleAddons(v.ownerId, v.policy, v.profileId)).filter((a) => supports(a, "stream", type, videoId));
  const { ok, failures } = await fanOut(addons, async (a) => {
    const r = StreamResponse.safeParse(await callAddon(a, "stream", type, videoId));
    if (!r.success) throw new Error("invalid stream response");
    return r.data.streams.flatMap((raw) => {
      const p = AddonStream.safeParse(raw);
      return p.success ? [toOption(a, p.data)] : [];
    });
  });

  let streams = ok.flatMap((r) => r.value);

  // De-duplicate identical torrents from multiple addons (keep first by addon order).
  const seen = new Set<string>();
  streams = streams.filter((s) => {
    const k = s.infoHash ? `${s.infoHash}:${s.fileIdx ?? ""}` : s.id;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // Debrid instant-availability where providers support it.
  const tokens = await debridTokens(v.ownerId);
  const providers = Object.keys(tokens) as DebridProvider[];
  const hashes = [...new Set(streams.map((s) => s.infoHash).filter((h): h is string => !!h))];
  if (providers.length && hashes.length) {
    const results = await Promise.all(
      providers.map(async (p) => {
        try {
          return [p, await ADAPTERS[p].checkCached(tokens[p]!, hashes)] as const;
        } catch (err) {
          logger.debug({ err, p }, "debrid cache check failed");
          return [p, new Map<string, boolean>()] as const;
        }
      }),
    );
    for (const s of streams) {
      if (!s.infoHash) continue;
      const flags: Partial<Record<DebridProvider, boolean>> = {};
      for (const [p, m] of results) if (m.has(s.infoHash)) flags[p] = m.get(s.infoHash)!;
      s.debridCached = Object.keys(flags).length ? flags : null;
    }
  }

  const isCached = (s: StreamOptionDto) => !!s.debridCached && Object.values(s.debridCached).some(Boolean);
  if (q.cachedOnly && providers.length) streams = streams.filter((s) => s.kind !== "torrent" || isCached(s));
  if (q.maxResolution) {
    const max = RES_ORDER.indexOf(q.maxResolution);
    streams = streams.filter((s) => s.info.resolution === "unknown" || RES_ORDER.indexOf(s.info.resolution as (typeof RES_ORDER)[number]) <= max);
  }
  streams.sort((a, b) => scoreStream(b.info, isCached(b), b.kind === "http") - scoreStream(a.info, isCached(a), a.kind === "http"));

  return { type, videoId, streams, failures };
}

export async function listSubtitles(v: Viewer, type: string, videoId: string) {
  await assertTitleAllowed(v, type, videoId);
  const addons = (await visibleAddons(v.ownerId, v.policy, v.profileId)).filter((a) => supports(a, "subtitles", type, videoId));
  const { ok } = await fanOut(addons, async (a) => {
    const r = SubtitlesResponse.safeParse(await callAddon(a, "subtitles", type, videoId));
    return r.success ? r.data.subtitles.map((s: AddonSubtitle) => ({ ...s, addonName: a.name })) : [];
  });
  return ok.flatMap((r) => r.value);
}

/** infoHash → per-provider cache flags, for providers that expose a cache check (TorBox). */
export async function checkCachedHashes(ownerId: string, hashes: string[]) {
  const tokens = await debridTokens(ownerId);
  const out: Record<string, Partial<Record<DebridProvider, boolean>>> = {};
  await Promise.all(
    (Object.keys(tokens) as DebridProvider[]).map(async (p) => {
      try {
        const m = await ADAPTERS[p].checkCached(tokens[p]!, hashes);
        for (const [h, v] of m) (out[h] ??= {})[p] = v;
      } catch (err) {
        logger.debug({ err, p }, "debrid cache check failed");
      }
    }),
  );
  return out;
}

/* ═══════════════ Resolution ═══════════════ */

interface TorrentRef {
  infoHash: string;
  fileIdx: number | null;
  sources?: string[];
  filename?: string | null;
}

function torrentStreamUrl(v: Viewer, userId: string, infoHash: string, fileIdx: number) {
  const st = signStreamToken({ sub: userId, pid: v.profileId, res: `torrent:${infoHash}:${fileIdx}` });
  return `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/stream/torrent/${infoHash}/${fileIdx}?st=${encodeURIComponent(st)}`;
}

async function resolveP2P(v: Viewer, userId: string, ref: TorrentRef, hint: ResolveStreamBody["hint"]): Promise<ResolvedStreamDto> {
  const t = await torrentEngine.addByHash(ref.infoHash, ref.sources);
  const info = torrentEngine.info(t);
  let idx = ref.fileIdx != null && info.files[ref.fileIdx]?.isVideo ? ref.fileIdx : null;
  if (idx == null && ref.filename) idx = info.files.find((f) => f.name === ref.filename)?.index ?? null;
  if (idx == null && hint?.episode != null)
    idx = info.files.find((f) => f.isVideo && f.episode === hint.episode && (hint.season == null || f.season == null || f.season === hint.season))?.index ?? null;
  idx ??= info.suggestedFileIdx;
  if (idx == null) throw new AppError("NOT_FOUND", "No playable video file in this torrent");
  const file = info.files[idx]!;
  torrentEngine.activate(ref.infoHash, idx);
  const parsed = parseStreamText(file.name);
  return {
    kind: "torrent",
    url: torrentStreamUrl(v, userId, ref.infoHash, idx),
    headers: null,
    expiresAt: null,
    filename: file.name,
    sizeBytes: file.sizeBytes,
    mimeType: mimeForFile(file.name),
    requiresNativePlayer: needsNativePlayer(parsed, file.name),
    provider: "p2p",
    torrent: { infoHash: ref.infoHash, fileIdx: idx },
  };
}

async function resolveTorrent(v: Viewer, userId: string, ref: TorrentRef, prefer: ResolveStreamBody["prefer"], hint: ResolveStreamBody["hint"]) {
  if (prefer === "p2p") return resolveP2P(v, userId, ref, hint);
  const tokens = await debridTokens(v.ownerId);
  const order: DebridProvider[] = prefer === "auto" ? DEBRID_PROVIDERS.filter((p) => tokens[p]) : [prefer];
  const fileHint = ref.filename ?? null;
  const ep = fileHint ? parseEpisode(fileHint) : { season: null, episode: null };
  const magnet = buildMagnet(ref.infoHash, { sources: ref.sources });

  for (const p of order) {
    const token = tokens[p];
    if (!token) {
      if (prefer !== "auto") throw new AppError("VAULT_SECRET_MISSING", `No ${p} token in the vault`);
      continue;
    }
    try {
      const r = await ADAPTERS[p].resolve(token, {
        infoHash: ref.infoHash,
        magnet,
        fileIdx: ref.fileIdx,
        filename: fileHint,
        season: hint?.season ?? ep.season,
        episode: hint?.episode ?? ep.episode,
      });
      const parsed = parseStreamText(r.filename ?? "");
      return {
        kind: "debrid",
        url: r.url,
        headers: null,
        expiresAt: new Date(Date.now() + 6 * 3600_000).toISOString(),
        filename: r.filename,
        sizeBytes: r.sizeBytes,
        mimeType: r.filename ? mimeForFile(r.filename) : null,
        requiresNativePlayer: needsNativePlayer(parsed, r.filename),
        provider: p,
        torrent: { infoHash: ref.infoHash, fileIdx: ref.fileIdx ?? 0 },
      } satisfies ResolvedStreamDto;
    } catch (e) {
      if (prefer !== "auto") throw e;
      logger.info({ provider: p, infoHash: ref.infoHash, err: e instanceof Error ? e.message : e }, "debrid miss, trying next");
    }
  }
  return resolveP2P(v, userId, ref, hint);
}

export async function resolve(v: Viewer, userId: string, body: ResolveStreamBody): Promise<ResolvedStreamDto> {
  if (body.source.type === "torrent") {
    if (!v.policy.allowMagnetInput) throw forbidden("Direct torrent playback isn't allowed on this profile");
    return resolveTorrent(v, userId, { infoHash: body.source.infoHash.toLowerCase(), fileIdx: body.source.fileIdx }, body.prefer, body.hint);
  }

  const { addonId } = body.source;
  const addon = (await visibleAddons(v.ownerId, v.policy, v.profileId)).find((a) => a.id === addonId);
  if (!addon) throw new AppError("NOT_FOUND", "Addon not available on this profile");
  const parsed = AddonStream.safeParse(body.source.stream);
  if (!parsed.success) throw new AppError("VALIDATION_FAILED", "Invalid stream object", parsed.error.issues.slice(0, 5));
  const s = parsed.data;
  const filename = s.behaviorHints?.filename ?? null;

  if (s.infoHash) {
    return resolveTorrent(
      v,
      userId,
      { infoHash: s.infoHash.toLowerCase(), fileIdx: s.fileIdx ?? null, sources: s.sources ?? undefined, filename },
      body.prefer,
      body.hint,
    );
  }
  if (s.url) {
    const info = parseStreamText([s.name, s.title, s.description, filename, s.url].filter(Boolean).join("\n"), s.behaviorHints?.videoSize ?? undefined);
    return {
      kind: "http",
      url: s.url,
      headers: s.behaviorHints?.proxyHeaders?.request ?? null,
      expiresAt: null,
      filename,
      sizeBytes: info.sizeBytes,
      mimeType: filename ? mimeForFile(filename) : null,
      requiresNativePlayer: needsNativePlayer(info, filename ?? s.url) || !!s.behaviorHints?.notWebReady,
      provider: "direct",
      torrent: null,
    };
  }
  if (s.ytId) {
    return {
      kind: "youtube",
      url: `https://www.youtube.com/watch?v=${encodeURIComponent(s.ytId)}`,
      headers: null,
      expiresAt: null,
      filename: null,
      sizeBytes: null,
      mimeType: null,
      requiresNativePlayer: false,
      provider: "direct",
      torrent: null,
    };
  }
  return {
    kind: "external",
    url: s.externalUrl!,
    headers: null,
    expiresAt: null,
    filename: null,
    sizeBytes: null,
    mimeType: null,
    requiresNativePlayer: false,
    provider: "direct",
    torrent: null,
  };
}

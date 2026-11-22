import type { Prisma } from "@prisma/client";
import { COMPLETION_THRESHOLD, type ContinueWatchingItemDto, type PutProgressBody } from "../../contracts/api.js";
import type { MetaDetail, MetaVideo } from "../../contracts/stremio.js";
import { prisma } from "../../db/prisma.js";
import { toProgressDto } from "../../lib/dto.js";
import { getMeta, type Viewer } from "../catalog/service.js";

/** Next episode after videoId in season/episode order (skips specials = season 0). */
export function nextVideoAfter(meta: Pick<MetaDetail, "videos">, videoId: string): MetaVideo | null {
  const vids = (meta.videos ?? [])
    .filter((v) => v.season == null || v.season > 0)
    .sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0));
  const i = vids.findIndex((v) => v.id === videoId);
  return i >= 0 ? (vids[i + 1] ?? null) : null;
}

async function upNextFor(v: Viewer | null, type: string, metaId: string, videoId: string): Promise<ContinueWatchingItemDto["upNext"]> {
  if (!v || type !== "series") return null;
  try {
    const { meta } = await getMeta(v, type, metaId);
    const n = nextVideoAfter(meta, videoId);
    return n && n.season != null && n.episode != null ? { videoId: n.id, season: n.season, episode: n.episode, title: n.title ?? n.name ?? null } : null;
  } catch {
    return null;
  }
}

export async function putProgress(v: Viewer, videoId: string, b: PutProgressBody) {
  const completed = b.durationSec > 0 && b.positionSec / b.durationSec >= COMPLETION_THRESHOLD;
  const data = {
    metaId: b.metaId,
    type: b.type,
    season: b.season ?? null,
    episode: b.episode ?? null,
    positionSec: b.positionSec,
    durationSec: b.durationSec,
    completed,
    ...(b.lastStream !== undefined ? { lastStream: (b.lastStream ?? undefined) as Prisma.InputJsonValue | undefined } : {}),
    ...(b.audioTrack !== undefined ? { audioTrack: b.audioTrack } : {}),
    ...(b.subtitleLang !== undefined ? { subtitleLang: b.subtitleLang } : {}),
    ...(b.subtitleDelayMs !== undefined ? { subtitleDelayMs: b.subtitleDelayMs } : {}),
  };
  const row = await prisma.watchProgress.upsert({
    where: { profileId_videoId: { profileId: v.profileId, videoId } },
    create: { profileId: v.profileId, videoId, ...data },
    update: data,
  });

  // Keep a library row (not necessarily on the watchlist) for display + "watched" state.
  const now = new Date();
  await prisma.libraryItem.upsert({
    where: { profileId_metaId: { profileId: v.profileId, metaId: b.metaId } },
    create: {
      profileId: v.profileId,
      metaId: b.metaId,
      type: b.type,
      name: b.meta?.name ?? b.metaId,
      poster: b.meta?.poster ?? null,
      background: b.meta?.background ?? null,
      inWatchlist: false,
      watched: completed && b.type === "movie",
      lastWatchedAt: now,
    },
    update: {
      lastWatchedAt: now,
      ...(b.meta ? { name: b.meta.name, poster: b.meta.poster ?? undefined, background: b.meta.background ?? undefined } : {}),
      ...(completed && b.type === "movie" ? { watched: true } : {}),
    },
  });

  const upNext = completed ? await upNextFor(v, b.type, b.metaId, videoId) : null;
  return { progress: toProgressDto(row), upNext };
}

/** Latest entry per title; in-progress items + finished series episodes with a next one. */
export async function continueWatching(profileId: string, v: Viewer | null = null, limit = 20): Promise<ContinueWatchingItemDto[]> {
  const rows = await prisma.watchProgress.findMany({ where: { profileId }, orderBy: { updatedAt: "desc" }, take: 200 });
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (!latest.has(r.metaId)) latest.set(r.metaId, r);

  const candidates = [...latest.values()].filter((r) => !r.completed || r.type === "series").slice(0, limit);
  const lib = await prisma.libraryItem.findMany({ where: { profileId, metaId: { in: candidates.map((c) => c.metaId) } } });
  const libMap = new Map(lib.map((l) => [l.metaId, l]));

  const items = await Promise.all(
    candidates.map(async (r): Promise<ContinueWatchingItemDto | null> => {
      const l = libMap.get(r.metaId);
      const upNext = r.completed ? await upNextFor(v, r.type, r.metaId, r.videoId) : null;
      if (r.completed && !upNext) return null;
      if (!r.completed && r.positionSec < 30) return null; // barely started
      return {
        meta: { id: r.metaId, type: r.type, name: l?.name ?? r.metaId, poster: l?.poster ?? undefined, background: l?.background ?? undefined },
        progress: toProgressDto(r),
        upNext,
      };
    }),
  );
  return items.filter((i): i is ContinueWatchingItemDto => i !== null);
}

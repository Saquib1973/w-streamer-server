import type { MediaType } from "@prisma/client";
import type { MaturityRating } from "../../contracts/api.js";
import { prisma } from "../../db/prisma.js";
import { fetchJson } from "../../lib/http-client.js";
import { logger } from "../../lib/logger.js";
import { normalizeRating } from "../../lib/maturity.js";
import { getSecret } from "../vault/service.js";

const FOUND_TTL_MS = 90 * 86_400_000;
const MISSING_TTL_MS = 7 * 86_400_000;
const CONCURRENCY = 8;
const COUNTRY = "US";

const asMediaType = (t: string): MediaType => (["movie", "series", "channel", "tv"].includes(t) ? (t as MediaType) : "other");

/** Meta id from a video id: "tt123:1:2" → "tt123", "kitsu:1:5" → "kitsu:1". */
export function metaIdFromVideoId(type: string, videoId: string): string {
  if (type === "movie") return videoId;
  const parts = videoId.split(":");
  return parts[0]!.startsWith("tt") ? parts[0]! : parts.slice(0, 2).join(":");
}

async function tmdbGet<T>(path: string, secret: string): Promise<T> {
  const isV4 = secret.startsWith("eyJ");
  const sep = path.includes("?") ? "&" : "?";
  const url = `https://api.themoviedb.org/3${path}${isV4 ? "" : `${sep}api_key=${encodeURIComponent(secret)}`}`;
  return fetchJson<T>(url, { headers: isV4 ? { authorization: `Bearer ${secret}` } : {}, timeoutMs: 5000, label: "TMDB" });
}

async function lookupTmdb(metaId: string, type: string, secret: string): Promise<string | null> {
  const isTv = type === "series" || type === "tv";
  let tmdbId: number | null = null;
  if (metaId.startsWith("tt")) {
    const r = await tmdbGet<{ movie_results: { id: number }[]; tv_results: { id: number }[] }>(`/find/${metaId}?external_source=imdb_id`, secret);
    tmdbId = (isTv ? r.tv_results[0]?.id : r.movie_results[0]?.id) ?? r.movie_results[0]?.id ?? r.tv_results[0]?.id ?? null;
  } else if (metaId.startsWith("tmdb:")) {
    tmdbId = Number(metaId.slice(5)) || null;
  }
  if (!tmdbId) return null;

  if (isTv) {
    const r = await tmdbGet<{ results: { iso_3166_1: string; rating: string }[] }>(`/tv/${tmdbId}/content_ratings`, secret);
    return r.results.find((x) => x.iso_3166_1 === COUNTRY)?.rating || null;
  }
  const r = await tmdbGet<{ results: { iso_3166_1: string; release_dates: { certification: string }[] }[] }>(`/movie/${tmdbId}/release_dates`, secret);
  const us = r.results.find((x) => x.iso_3166_1 === COUNTRY);
  return us?.release_dates.map((d) => d.certification).find((c) => !!c) || null;
}

/**
 * Batch-resolve certifications. Returns metaId → rating (null = unknown/unrated).
 * Without a TMDB token in the vault everything is unrated.
 */
export async function getRatings(ownerId: string, items: { id: string; type: string }[]): Promise<Map<string, MaturityRating | null>> {
  const out = new Map<string, MaturityRating | null>();
  if (items.length === 0) return out;
  const ids = [...new Set(items.map((i) => i.id))];
  const cached = await prisma.ratingCache.findMany({ where: { metaId: { in: ids } } });
  const now = Date.now();
  const fresh = new Set<string>();
  for (const c of cached) {
    const ttl = c.rawRating ? FOUND_TTL_MS : MISSING_TTL_MS;
    if (now - c.fetchedAt.getTime() < ttl) {
      out.set(c.metaId, c.certification);
      fresh.add(c.metaId);
    }
  }
  const missing = items.filter((i, idx, arr) => !fresh.has(i.id) && arr.findIndex((x) => x.id === i.id) === idx);
  if (missing.length === 0) return out;

  const tmdb = await getSecret(ownerId, "TMDB");
  if (!tmdb) {
    for (const m of missing) out.set(m.id, null);
    return out;
  }

  let cursor = 0;
  const worker = async () => {
    while (cursor < missing.length) {
      const item = missing[cursor++]!;
      try {
        const raw = await lookupTmdb(item.id, item.type, tmdb.secret);
        const cert = normalizeRating(raw);
        out.set(item.id, cert);
        await prisma.ratingCache.upsert({
          where: { metaId: item.id },
          create: { metaId: item.id, type: asMediaType(item.type), certification: cert, rawRating: raw, country: COUNTRY },
          update: { certification: cert, rawRating: raw, fetchedAt: new Date() },
        });
      } catch (err) {
        logger.debug({ err, id: item.id }, "rating lookup failed");
        out.set(item.id, null); // transient failure → not cached, treated as unrated
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, missing.length) }, worker));
  return out;
}

export async function getRating(ownerId: string, id: string, type: string) {
  return (await getRatings(ownerId, [{ id, type }])).get(id) ?? null;
}

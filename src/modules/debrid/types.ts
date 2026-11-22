import type { DebridProvider } from "../../contracts/api.js";
import { parseEpisode, VIDEO_EXT } from "../../lib/stream-parser.js";

export interface DebridTarget {
  infoHash: string;
  magnet: string;
  /** Addon's fileIdx (index in the torrent's file list) — best-effort, ordering can differ per debrid. */
  fileIdx?: number | null;
  filename?: string | null;
  season?: number | null;
  episode?: number | null;
}

export interface DebridResolved {
  url: string;
  filename: string | null;
  sizeBytes: number | null;
}

export interface DebridAdapter {
  provider: DebridProvider;
  /** Returns infoHash → cached. Providers without a cache-check API return an empty map. */
  checkCached(token: string, infoHashes: string[]): Promise<Map<string, boolean>>;
  /** Resolves only if instantly available (cached). Throws DEBRID_ERROR otherwise. */
  resolve(token: string, t: DebridTarget): Promise<DebridResolved>;
}

export interface CandidateFile {
  ref: string | number; // provider-specific id
  path: string;
  size: number;
}

/** Picks the right file: exact filename → S/E match → addon index → largest video. */
export function pickFile<F extends CandidateFile>(files: F[], t: DebridTarget, indexOrder?: F[]): F | null {
  const videos = files.filter((f) => VIDEO_EXT.test(f.path) && !/\bsample\b/i.test(f.path));
  const pool = videos.length ? videos : files;
  if (t.filename) {
    const fn = t.filename.toLowerCase();
    const hit = pool.find((f) => f.path.toLowerCase().endsWith(fn));
    if (hit) return hit;
  }
  if (t.episode != null) {
    const hit = pool.find((f) => {
      const e = parseEpisode(f.path.split("/").pop() ?? f.path);
      return e.episode === t.episode && (t.season == null || e.season == null || e.season === t.season);
    });
    if (hit) return hit;
  }
  if (t.fileIdx != null && indexOrder?.[t.fileIdx] && pool.includes(indexOrder[t.fileIdx]!)) return indexOrder[t.fileIdx]!;
  return pool.reduce<F | null>((best, f) => (!best || f.size > best.size ? f : best), null);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

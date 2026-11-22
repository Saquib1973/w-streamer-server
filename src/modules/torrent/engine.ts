import path from "node:path";
import { mkdir } from "node:fs/promises";
import type WebTorrentT from "webtorrent";
import type { Torrent } from "webtorrent";
import { env } from "../../config/env.js";
import type { TorrentFileDto, TorrentInfoDto, TorrentStatsDto } from "../../contracts/api.js";
import { AppError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { parseEpisode, VIDEO_EXT } from "../../lib/stream-parser.js";

export const PUBLIC_TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.demonii.com:1337/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://exodus.desync.com:6969/announce",
  "udp://tracker.openbittorrent.com:6969/announce",
  "wss://tracker.openwebtorrent.com",
];

export function buildMagnet(infoHash: string, opts: { name?: string; sources?: string[] } = {}): string {
  const trackers = new Set(PUBLIC_TRACKERS);
  for (const s of opts.sources ?? []) if (s.startsWith("tracker:")) trackers.add(s.slice(8));
  const tr = [...trackers].map((t) => `&tr=${encodeURIComponent(t)}`).join("");
  return `magnet:?xt=urn:btih:${infoHash.toLowerCase()}${opts.name ? `&dn=${encodeURIComponent(opts.name)}` : ""}${tr}`;
}

interface Entry {
  torrent: Torrent;
  lastAccess: number;
  activeStreams: number;
  activeFileIdx: number | null;
}

class TorrentEngine {
  private client: WebTorrentT | null = null;
  private loading: Promise<WebTorrentT> | null = null;
  private entries = new Map<string, Entry>();
  private pending = new Map<string, Promise<Torrent>>();
  private reaper: NodeJS.Timeout | null = null;
  readonly cacheDir = path.resolve(env.TORRENT_CACHE_DIR);

  get isUp() {
    return this.client !== null;
  }

  private async getClient(): Promise<WebTorrentT> {
    if (this.client) return this.client;
    this.loading ??= (async () => {
      await mkdir(this.cacheDir, { recursive: true });
      const { default: WebTorrent } = await import("webtorrent");
      const c = new WebTorrent({ maxConns: env.TORRENT_MAX_CONNS, dht: true, lsd: true, utp: true, webSeeds: true });
      c.on("error", (err: unknown) => logger.error({ err }, "webtorrent client error"));
      this.client = c;
      this.reaper = setInterval(() => this.reap(), 60_000).unref();
      logger.info({ cacheDir: this.cacheDir }, "torrent engine started");
      return c;
    })();
    return this.loading;
  }

  /** Destroys torrents idle for longer than TORRENT_IDLE_TIMEOUT_MIN. */
  private reap() {
    const cutoff = Date.now() - env.TORRENT_IDLE_TIMEOUT_MIN * 60_000;
    for (const [hash, e] of this.entries) if (e.activeStreams === 0 && e.lastAccess < cutoff) void this.remove(hash);
  }

  private async makeRoom() {
    if (this.entries.size < env.TORRENT_MAX_ACTIVE) return;
    const idle = [...this.entries.entries()].filter(([, e]) => e.activeStreams === 0).sort((a, b) => a[1].lastAccess - b[1].lastAccess);
    if (!idle[0]) throw new AppError("TORRENT_LIMIT_REACHED", `Max ${env.TORRENT_MAX_ACTIVE} torrents are streaming right now`);
    await this.remove(idle[0][0]);
  }

  /** Adds a torrent (magnet / info hash / .torrent buffer) and waits for metadata. */
  async add(source: string | Buffer, key?: string): Promise<Torrent> {
    const hashKey = key?.toLowerCase();
    if (hashKey) {
      const existing = this.entries.get(hashKey);
      if (existing) {
        existing.lastAccess = Date.now();
        return existing.torrent;
      }
      const p = this.pending.get(hashKey);
      if (p) return p;
    }
    const client = await this.getClient();
    await this.makeRoom();

    const promise = new Promise<Torrent>((resolve, reject) => {
      let t: Torrent;
      const timer = setTimeout(() => {
        try {
          t?.destroy({ destroyStore: true });
        } catch {
          /* noop */
        }
        reject(new AppError("TORRENT_METADATA_TIMEOUT", "Couldn't fetch torrent metadata (no peers?)"));
      }, env.TORRENT_METADATA_TIMEOUT_SEC * 1000);

      try {
        t = client.add(source, { path: this.cacheDir, deselect: true, destroyStoreOnDestroy: true, announce: PUBLIC_TRACKERS });
      } catch (e) {
        clearTimeout(timer);
        // Duplicate add: return the existing instance.
        const m = /duplicate torrent ([a-f0-9]{40})/i.exec(String(e));
        if (m) {
          const ex = this.entries.get(m[1]!.toLowerCase());
          if (ex) return resolve(ex.torrent);
        }
        return reject(new AppError("VALIDATION_FAILED", "Invalid magnet or torrent file"));
      }
      t.once("error", (err: unknown) => {
        clearTimeout(timer);
        reject(new AppError("VALIDATION_FAILED", `Torrent error: ${err instanceof Error ? err.message : String(err)}`));
      });
      const onReady = () => {
        clearTimeout(timer);
        t.files.forEach((f) => f.deselect());
        this.entries.set(t.infoHash.toLowerCase(), { torrent: t, lastAccess: Date.now(), activeStreams: 0, activeFileIdx: null });
        logger.info({ infoHash: t.infoHash, name: t.name, files: t.files.length }, "torrent ready");
        resolve(t);
      };
      if (t.ready) onReady();
      else t.once("ready", onReady);
    });

    if (hashKey) {
      this.pending.set(hashKey, promise);
      promise.finally(() => this.pending.delete(hashKey)).catch(() => undefined);
    }
    return promise;
  }

  async addByHash(infoHash: string, sources?: string[]) {
    return this.add(buildMagnet(infoHash, { sources }), infoHash);
  }

  get(infoHash: string): Entry | undefined {
    const e = this.entries.get(infoHash.toLowerCase());
    if (e) e.lastAccess = Date.now();
    return e;
  }

  async remove(infoHash: string) {
    const e = this.entries.get(infoHash.toLowerCase());
    if (!e) return;
    this.entries.delete(infoHash.toLowerCase());
    await new Promise<void>((r) => e.torrent.destroy({ destroyStore: true }, () => r()));
    logger.info({ infoHash }, "torrent removed");
  }

  /** Marks a file as the active stream target: selects it and deselects others. */
  activate(infoHash: string, fileIdx: number) {
    const e = this.get(infoHash);
    if (!e) throw new AppError("NOT_FOUND", "Torrent not loaded");
    const file = e.torrent.files[fileIdx];
    if (!file) throw new AppError("NOT_FOUND", "File not in torrent");
    if (e.activeFileIdx !== fileIdx) {
      e.torrent.files.forEach((f, i) => i !== fileIdx && f.deselect());
      file.select();
      e.activeFileIdx = fileIdx;
    }
    return { entry: e, file };
  }

  info(t: Torrent): TorrentInfoDto {
    const files: TorrentFileDto[] = t.files.map((f, index) => {
      const ep = parseEpisode(f.name);
      return { index, name: f.name, path: f.path, sizeBytes: f.length, isVideo: VIDEO_EXT.test(f.name) && !/\bsample\b/i.test(f.name), ...ep };
    });
    const videos = files.filter((f) => f.isVideo);
    const suggested = videos.reduce<TorrentFileDto | null>((b, f) => (!b || f.sizeBytes > b.sizeBytes ? f : b), null);
    return { infoHash: t.infoHash, name: t.name, totalBytes: t.length, files, suggestedFileIdx: suggested?.index ?? null, stats: this.stats(t) };
  }

  stats(t: Torrent): TorrentStatsDto {
    const e = this.entries.get(t.infoHash.toLowerCase());
    const f = e?.activeFileIdx != null ? t.files[e.activeFileIdx] : undefined;
    return {
      peers: t.numPeers,
      downloadSpeed: Math.round(t.downloadSpeed),
      uploadSpeed: Math.round(t.uploadSpeed),
      progress: t.progress,
      downloadedBytes: t.downloaded,
      bufferHealth: f ? Math.min(1, f.progress) : null,
      state: t.destroyed ? "destroyed" : !t.ready ? "fetching_metadata" : e?.activeStreams ? "streaming" : f ? "ready" : "idle",
    };
  }

  async shutdown() {
    if (this.reaper) clearInterval(this.reaper);
    if (!this.client) return;
    await new Promise<void>((r) => this.client!.destroy(() => r()));
  }
}

export const torrentEngine = new TorrentEngine();

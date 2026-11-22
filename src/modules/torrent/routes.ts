import { Router, type Request, type Response } from "express";
import multer from "multer";
import { AddTorrentBody, type ApiResponses } from "../../contracts/api.js";
import { AppError } from "../../lib/errors.js";
import { verifyStreamToken } from "../../lib/jwt.js";
import { logger } from "../../lib/logger.js";
import { mimeForFile } from "../../lib/stream-parser.js";
import { authenticate, requireFlag, requireProfile } from "../../middleware/auth.js";
import { param, parseBody } from "../../middleware/validate.js";
import { torrentEngine } from "./engine.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024, files: 1 } });
const HASH_RE = /^[a-f0-9]{40}$/i;

const hashParam = (req: Request) => {
  const h = param(req, "infoHash");
  if (!HASH_RE.test(h)) throw new AppError("VALIDATION_FAILED", "Invalid info hash");
  return h.toLowerCase();
};

/* ─────────── /api/v1/torrents ─────────── */

export const torrentsRouter = Router();
torrentsRouter.use(authenticate);

torrentsRouter.post("/", requireFlag("allowMagnetInput"), upload.single("torrent"), async (req, res) => {
  let t;
  if (req.file) {
    t = await torrentEngine.add(req.file.buffer);
  } else {
    const body = parseBody(AddTorrentBody, req);
    if (body.magnet) {
      const m = /xt=urn:btih:([a-z0-9]{32,40})/i.exec(body.magnet);
      t = await torrentEngine.add(body.magnet, m?.[1]?.length === 40 ? m[1] : undefined);
    } else if (body.infoHash) t = await torrentEngine.addByHash(body.infoHash);
    else t = await torrentEngine.add(Buffer.from(body.torrentFileBase64!, "base64"));
  }
  const out: ApiResponses["POST /torrents"] = torrentEngine.info(t);
  res.status(201).json(out);
});

torrentsRouter.get("/:infoHash", requireProfile, async (req, res) => {
  const e = torrentEngine.get(hashParam(req));
  if (!e) throw new AppError("NOT_FOUND", "Torrent not loaded");
  const out: ApiResponses["GET /torrents/:infoHash"] = torrentEngine.info(e.torrent);
  res.json(out);
});

torrentsRouter.get("/:infoHash/stats", requireProfile, async (req, res) => {
  const e = torrentEngine.get(hashParam(req));
  if (!e) throw new AppError("NOT_FOUND", "Torrent not loaded");
  const out: ApiResponses["GET /torrents/:infoHash/stats"] = torrentEngine.stats(e.torrent);
  res.json(out);
});

torrentsRouter.delete("/:infoHash", requireProfile, async (req, res) => {
  await torrentEngine.remove(hashParam(req));
  const out: ApiResponses["DELETE /torrents/:infoHash"] = { ok: true };
  res.json(out);
});

/* ─────────── /stream/torrent/:infoHash/:fileIdx?st=… (HTTP Range) ─────────── */

export const streamRouter = Router();

async function serveTorrentFile(req: Request, res: Response) {
  const infoHash = hashParam(req);
  const fileIdx = Number(param(req, "fileIdx"));
  if (!Number.isInteger(fileIdx) || fileIdx < 0) throw new AppError("VALIDATION_FAILED", "Invalid file index");
  const st = typeof req.query.st === "string" ? req.query.st : "";
  verifyStreamToken(st, `torrent:${infoHash}:${fileIdx}`);

  // Re-add if the engine evicted it (e.g. resume after idle teardown).
  if (!torrentEngine.get(infoHash)) await torrentEngine.addByHash(infoHash);
  const { entry, file } = torrentEngine.activate(infoHash, fileIdx);

  const size = file.length;
  const mime = mimeForFile(file.name);
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", mime);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`);

  let start = 0;
  let end = size - 1;
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m || (!m[1] && !m[2])) {
      res.status(416).setHeader("Content-Range", `bytes */${size}`).end();
      return;
    }
    if (m[1]) {
      start = Number(m[1]);
      end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    } else {
      start = Math.max(0, size - Number(m[2])); // suffix range: last N bytes (MKV cues / MP4 moov)
    }
    if (start > end || start >= size) {
      res.status(416).setHeader("Content-Range", `bytes */${size}`).end();
      return;
    }
    res.status(206).setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
  } else {
    res.status(200);
  }
  res.setHeader("Content-Length", String(end - start + 1));
  if (req.method === "HEAD") {
    res.end();
    return;
  }

  entry.activeStreams++;
  entry.lastAccess = Date.now();
  // WebTorrent's file stream prioritizes pieces from `start` onward (sequential readahead).
  const stream = file.createReadStream({ start, end });
  let closed = false;
  const done = () => {
    if (closed) return;
    closed = true;
    entry.activeStreams = Math.max(0, entry.activeStreams - 1);
    entry.lastAccess = Date.now();
    stream.destroy();
  };
  res.on("close", done);
  stream.on("error", (err) => {
    logger.debug({ err, infoHash }, "torrent read stream error");
    done();
    if (!res.headersSent) res.status(500);
    res.end();
  });
  stream.pipe(res);
}

streamRouter.get("/torrent/:infoHash/:fileIdx", serveTorrentFile);
streamRouter.head("/torrent/:infoHash/:fileIdx", serveTorrentFile);

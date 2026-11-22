import { Router } from "express";
import { CatalogQuery, SearchQuery, type ApiResponses, type MetaDetailDto } from "../../contracts/api.js";
import { prisma } from "../../db/prisma.js";
import { AppError } from "../../lib/errors.js";
import { isAllowed } from "../../lib/maturity.js";
import { authenticate, ctx, requireProfile } from "../../middleware/auth.js";
import { param, parseQuery, uuidParam } from "../../middleware/validate.js";
import { getRating } from "../ratings/service.js";
import { continueWatching, nextVideoAfter } from "../progress/service.js";
import * as svc from "./service.js";

export const catalogRouter = Router();
catalogRouter.use(authenticate, requireProfile);

const viewer = (req: Parameters<typeof ctx>[0]): svc.Viewer => {
  const c = ctx(req);
  return { ownerId: c.ownerId, profileId: c.profile.id, policy: c.policy };
};

catalogRouter.get("/board", async (req, res) => {
  const v = viewer(req);
  const [b, cw] = await Promise.all([svc.board(v), continueWatching(v.profileId, v)]);
  const out: ApiResponses["GET /board"] = { hero: b.hero, continueWatching: cw, rows: b.rows };
  res.json(out);
});

catalogRouter.get("/discover", async (req, res) => {
  const out: ApiResponses["GET /discover"] = { filters: await svc.discoverFilters(viewer(req)) };
  res.json(out);
});

catalogRouter.get("/catalog/:addonId/:type/:catalogId", async (req, res) => {
  const q = parseQuery(CatalogQuery, req);
  const out: ApiResponses["GET /catalog/:addonId/:type/:catalogId"] = await svc.catalogPage(
    viewer(req),
    uuidParam(req, "addonId"),
    param(req, "type"),
    param(req, "catalogId"),
    q,
  );
  res.json(out);
});

catalogRouter.get("/search", async (req, res) => {
  const q = parseQuery(SearchQuery, req);
  const out: ApiResponses["GET /search"] = await svc.search(viewer(req), q.q, q.type);
  res.json(out);
});

catalogRouter.get("/meta/:type/:id", async (req, res) => {
  const v = viewer(req);
  const type = param(req, "type");
  const id = param(req, "id");

  const certification = await getRating(v.ownerId, id, type);
  if (!isAllowed(v.policy, certification)) throw new AppError("CONTENT_RESTRICTED", "This title isn't available on this profile");

  const { meta, addon } = await svc.getMeta(v, type, id);
  const [lib, progressRows] = await Promise.all([
    prisma.libraryItem.findUnique({ where: { profileId_metaId: { profileId: v.profileId, metaId: id } } }),
    prisma.watchProgress.findMany({ where: { profileId: v.profileId, metaId: id } }),
  ]);
  const progress: MetaDetailDto["progress"] = {};
  for (const p of progressRows) progress[p.videoId] = { positionSec: p.positionSec, durationSec: p.durationSec, completed: p.completed };

  const latest = progressRows.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
  const nextVideoId = latest ? (latest.completed ? nextVideoAfter(meta, latest.videoId)?.id ?? null : latest.videoId) : null;

  const out: ApiResponses["GET /meta/:type/:id"] = {
    meta: {
      ...meta,
      certification,
      sourceAddonId: addon.id,
      library: lib ? { inWatchlist: lib.inWatchlist, watched: lib.watched } : null,
      progress,
      nextVideoId,
    },
  };
  res.json(out);
});

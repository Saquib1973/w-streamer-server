import { Router } from "express";
import { MediaType, PutProgressBody, UpsertLibraryBody, type ApiResponses } from "../../contracts/api.js";
import { prisma } from "../../db/prisma.js";
import { toLibraryItemDto, toProgressDto } from "../../lib/dto.js";
import { AppError } from "../../lib/errors.js";
import { isAllowed } from "../../lib/maturity.js";
import { authenticate, ctx, requireProfile } from "../../middleware/auth.js";
import { param, parseBody } from "../../middleware/validate.js";
import { getRating } from "../ratings/service.js";
import type { Viewer } from "../catalog/service.js";
import { continueWatching, putProgress } from "./service.js";

const viewer = (req: Parameters<typeof ctx>[0]): Viewer => {
  const c = ctx(req);
  return { ownerId: c.ownerId, profileId: c.profile.id, policy: c.policy };
};

/* ─────────── /library ─────────── */

export const libraryRouter = Router();
libraryRouter.use(authenticate, requireProfile);

libraryRouter.get("/", async (req, res) => {
  const v = viewer(req);
  const type = MediaType.safeParse(req.query.type);
  const watchlistOnly = req.query.watchlist !== "false";
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
  const rows = await prisma.libraryItem.findMany({
    where: { profileId: v.profileId, ...(type.success ? { type: type.data } : {}), ...(watchlistOnly ? { inWatchlist: true } : {}) },
    orderBy: [{ addedAt: "desc" }, { id: "desc" }],
    take: 61,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const page = rows.slice(0, 60);
  const out: ApiResponses["GET /library"] = {
    items: page.map(toLibraryItemDto),
    nextCursor: rows.length > 60 ? page[page.length - 1]!.id : null,
  };
  res.json(out);
});

libraryRouter.put("/:metaId", async (req, res) => {
  const v = viewer(req);
  const metaId = param(req, "metaId");
  const body = parseBody(UpsertLibraryBody, req);
  const certification = await getRating(v.ownerId, metaId, body.type);
  if (!isAllowed(v.policy, certification)) throw new AppError("CONTENT_RESTRICTED", "This title isn't available on this profile");
  const data = {
    type: body.type,
    name: body.name,
    poster: body.poster ?? null,
    background: body.background ?? null,
    year: body.year ?? null,
    certification,
    ...(body.inWatchlist !== undefined ? { inWatchlist: body.inWatchlist } : {}),
    ...(body.watched !== undefined ? { watched: body.watched } : {}),
  };
  const item = await prisma.libraryItem.upsert({
    where: { profileId_metaId: { profileId: v.profileId, metaId } },
    create: { profileId: v.profileId, metaId, ...data, inWatchlist: body.inWatchlist ?? true },
    update: data,
  });
  const out: ApiResponses["PUT /library/:metaId"] = { item: toLibraryItemDto(item) };
  res.json(out);
});

libraryRouter.delete("/:metaId", async (req, res) => {
  const v = viewer(req);
  await prisma.libraryItem.deleteMany({ where: { profileId: v.profileId, metaId: param(req, "metaId") } });
  const out: ApiResponses["DELETE /library/:metaId"] = { ok: true };
  res.json(out);
});

/* ─────────── /progress ─────────── */

export const progressRouter = Router();
progressRouter.use(authenticate, requireProfile);

progressRouter.get("/continue-watching", async (req, res) => {
  const v = viewer(req);
  const out: ApiResponses["GET /progress/continue-watching"] = { items: await continueWatching(v.profileId, v) };
  res.json(out);
});

progressRouter.get("/:metaId", async (req, res) => {
  const v = viewer(req);
  const rows = await prisma.watchProgress.findMany({
    where: { profileId: v.profileId, metaId: param(req, "metaId") },
    orderBy: [{ season: "asc" }, { episode: "asc" }],
  });
  const out: ApiResponses["GET /progress/:metaId"] = { items: rows.map(toProgressDto) };
  res.json(out);
});

progressRouter.put("/:videoId", async (req, res) => {
  const body = parseBody(PutProgressBody, req);
  const out: ApiResponses["PUT /progress/:videoId"] = await putProgress(viewer(req), param(req, "videoId"), body);
  res.json(out);
});

progressRouter.delete("/:videoId", async (req, res) => {
  const v = viewer(req);
  await prisma.watchProgress.deleteMany({ where: { profileId: v.profileId, videoId: param(req, "videoId") } });
  const out: ApiResponses["DELETE /progress/:videoId"] = { ok: true };
  res.json(out);
});

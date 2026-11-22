import { Router } from "express";
import { AddonUrlBody, ImportStremioBody, InstallAddonBody, ReorderAddonsBody, UpdateAddonBody, type ApiResponses } from "../../contracts/api.js";
import { importFromStremio } from "./stremio-import.js";
import { prisma } from "../../db/prisma.js";
import { toAddonDto } from "../../lib/dto.js";
import { audit } from "../../lib/audit.js";
import { AppError, notFound } from "../../lib/errors.js";
import { authenticate, ctx, requireAdmin, requireFlag, requireProfile } from "../../middleware/auth.js";
import { parseBody, uuidParam } from "../../middleware/validate.js";
import * as svc from "./service.js";

export const addonsRouter = Router();
addonsRouter.use(authenticate);

async function ownedAddon(ownerId: string, id: string) {
  const a = await prisma.addon.findUnique({ where: { id } });
  if (!a || a.userId !== ownerId) throw notFound("Addon");
  return a;
}

addonsRouter.get("/", requireProfile, async (req, res) => {
  const c = ctx(req);
  const addons = c.policy.restricted
    ? await svc.visibleAddons(c.ownerId, c.policy, c.profile.id)
    : await prisma.addon.findMany({ where: { userId: c.ownerId }, orderBy: { sortOrder: "asc" } }); // admin sees disabled too
  const out: ApiResponses["GET /addons"] = { addons: addons.map(toAddonDto) };
  res.json(out);
});

addonsRouter.post("/validate", requireFlag("allowAddonInstall"), async (req, res) => {
  const body = parseBody(AddonUrlBody, req);
  const out: ApiResponses["POST /addons/validate"] = await svc.validateAddon(req.auth!.ownerId, body.transportUrl);
  res.json(out);
});

addonsRouter.post("/", requireFlag("allowAddonInstall"), async (req, res) => {
  const body = parseBody(InstallAddonBody, req);
  const c = ctx(req);
  const addon = await svc.installAddon(c.ownerId, body.transportUrl, {
    injectVault: c.policy.restricted ? false : body.injectVault,
    policy: c.policy,
    profileId: c.profile.id,
  });
  const out: ApiResponses["POST /addons"] = { addon: toAddonDto(addon) };
  res.status(201).json(out);
});

addonsRouter.post("/import/stremio", requireAdmin, async (req, res) => {
  const body = parseBody(ImportStremioBody, req);
  const out: ApiResponses["POST /addons/import/stremio"] = await importFromStremio(req.auth!.ownerId, body.email, body.password, body.skipExisting);
  audit("ADDON_INSTALLED", { userId: req.auth!.userId, meta: { source: "stremio-import", imported: out.imported.length, failed: out.failed.length } });
  res.json(out);
});

addonsRouter.put("/order", requireAdmin, async (req, res) => {
  const body = parseBody(ReorderAddonsBody, req);
  const owned = await prisma.addon.findMany({ where: { userId: req.auth!.ownerId }, select: { id: true } });
  const ownedSet = new Set(owned.map((a) => a.id));
  const ids = body.ids.filter((id) => ownedSet.has(id));
  // Unlisted addons keep relative order after the listed ones.
  const rest = owned.map((a) => a.id).filter((id) => !ids.includes(id));
  await prisma.$transaction([...ids, ...rest].map((id, i) => prisma.addon.update({ where: { id }, data: { sortOrder: i } })));
  const addons = await prisma.addon.findMany({ where: { userId: req.auth!.ownerId }, orderBy: { sortOrder: "asc" } });
  const out: ApiResponses["PUT /addons/order"] = { addons: addons.map(toAddonDto) };
  res.json(out);
});

addonsRouter.patch("/:id", requireAdmin, async (req, res) => {
  const id = uuidParam(req, "id");
  const body = parseBody(UpdateAddonBody, req);
  await ownedAddon(req.auth!.ownerId, id);
  const addon = await prisma.addon.update({ where: { id }, data: body });
  audit("ADDON_UPDATED", { userId: req.auth!.userId, meta: { addonId: id, ...body } });
  const out: ApiResponses["PATCH /addons/:id"] = { addon: toAddonDto(addon) };
  res.json(out);
});

addonsRouter.post("/:id/refresh", requireAdmin, async (req, res) => {
  const a = await ownedAddon(req.auth!.ownerId, uuidParam(req, "id"));
  const out: ApiResponses["POST /addons/:id/refresh"] = { addon: toAddonDto(await svc.refreshAddon(a)) };
  res.json(out);
});

addonsRouter.delete("/:id", requireAdmin, async (req, res) => {
  const a = await ownedAddon(req.auth!.ownerId, uuidParam(req, "id"));
  if (a.isProtected) throw new AppError("CONFLICT", `${a.name} is built-in and can't be removed (disable it instead)`);
  await prisma.addon.delete({ where: { id: a.id } });
  audit("ADDON_REMOVED", { userId: req.auth!.userId, meta: { name: a.name } });
  const out: ApiResponses["DELETE /addons/:id"] = { ok: true };
  res.json(out);
});

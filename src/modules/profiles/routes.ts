import { Router } from "express";
import {
  CreateProfileBody,
  ProfileAddonAccessBody,
  SelectProfileBody,
  SetPinBody,
  UpdateProfileBody,
  type ApiResponses,
} from "../../contracts/api.js";
import { prisma } from "../../db/prisma.js";
import { toAddonDto, toProfileDto } from "../../lib/dto.js";
import { AppError, forbidden } from "../../lib/errors.js";
import { audit } from "../../lib/audit.js";
import { verifySecret, hashSecret } from "../../lib/crypto/password.js";
import { authenticate, invalidateProfile, requireAdmin, requireProfile } from "../../middleware/auth.js";
import { pinLimiter } from "../../middleware/rate-limit.js";
import { parseBody, uuidParam } from "../../middleware/validate.js";
import { clientMeta, issueSession, revokeRefreshToken } from "../auth/session.js";
import * as svc from "./service.js";

export const profilesRouter = Router();
profilesRouter.use(authenticate);

profilesRouter.get("/", async (req, res) => {
  const profiles = await prisma.profile.findMany({
    where: { userId: req.auth!.userId },
    orderBy: [{ kind: "desc" }, { sortOrder: "asc" }, { createdAt: "asc" }],
  });
  const out: ApiResponses["GET /profiles"] = { profiles: profiles.map(toProfileDto) };
  res.json(out);
});

profilesRouter.post("/", requireAdmin, async (req, res) => {
  const body = parseBody(CreateProfileBody, req);
  const profile = await svc.createChildProfile(req.auth!.userId, body);
  const out: ApiResponses["POST /profiles"] = { profile: toProfileDto(profile) };
  res.status(201).json(out);
});

profilesRouter.patch("/:id", requireProfile, async (req, res) => {
  const id = uuidParam(req, "id");
  const body = parseBody(UpdateProfileBody, req);
  const target = await svc.getOwnedProfile(req.auth!.userId, id);
  const isAdmin = req.auth!.role === "ADMIN" && req.profileCtx!.profile.kind === "OWNER";

  let data;
  if (isAdmin) {
    data = svc.profileData(body);
    if (target.kind === "OWNER") {
      // Owner profile can't be locked or restricted.
      delete data.isLocked;
      for (const k of ["maturityCap", "hideUnrated", "hideAdultAddons", "allowMagnetInput", "allowAddonInstall", "addonAllowlistOnly"] as const) delete data[k];
    }
  } else {
    // Children may only edit their OWN player preferences.
    if (target.id !== req.profileCtx!.profile.id) throw forbidden();
    data = svc.profileData({ preferences: body.preferences });
  }
  const profile = await svc.updateProfile(id, data, isAdmin && target.kind === "CHILD" ? body.pin : undefined);
  audit("PROFILE_UPDATED", { userId: req.auth!.userId, profileId: id });
  const out: ApiResponses["PATCH /profiles/:id"] = { profile: toProfileDto(profile) };
  res.json(out);
});

profilesRouter.delete("/:id", requireAdmin, async (req, res) => {
  const id = uuidParam(req, "id");
  const target = await svc.getOwnedProfile(req.auth!.userId, id);
  if (target.kind === "OWNER") throw new AppError("CONFLICT", "The owner profile can't be deleted");
  await prisma.profile.delete({ where: { id } });
  invalidateProfile(id);
  audit("PROFILE_DELETED", { userId: req.auth!.userId, profileId: id });
  const out: ApiResponses["DELETE /profiles/:id"] = { ok: true };
  res.json(out);
});

/** Switch active profile. Issues a fresh token pair bound to the new profile. */
profilesRouter.post("/:id/select", pinLimiter, async (req, res) => {
  const id = uuidParam(req, "id");
  const body = parseBody(SelectProfileBody, req);
  const target = await svc.getOwnedProfile(req.auth!.userId, id);
  if (target.isLocked) throw forbidden("This profile is locked");
  await svc.checkPin(target, body.pin, req.ip);

  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.auth!.userId } });
  if (body.refreshToken) await revokeRefreshToken(user.id, body.refreshToken);
  const { tokens } = await issueSession(user, target, clientMeta(req, body.deviceName));
  const out: ApiResponses["POST /profiles/:id/select"] = { profile: toProfileDto(target), tokens };
  res.json(out);
});

profilesRouter.put("/:id/pin", requireAdmin, async (req, res) => {
  const id = uuidParam(req, "id");
  const body = parseBody(SetPinBody, req);
  const target = await svc.getOwnedProfile(req.auth!.userId, id);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.auth!.userId } });
  if (!(await verifySecret(user.passwordHash, body.password))) throw new AppError("INVALID_CREDENTIALS", "Password is incorrect");
  if (body.pin === null && target.kind === "OWNER") throw new AppError("CONFLICT", "The owner profile must keep a PIN");
  await prisma.profile.update({
    where: { id },
    data: { pinHash: body.pin ? await hashSecret(body.pin) : null, pinFailedCount: 0, pinLockedUntil: null },
  });
  invalidateProfile(id);
  audit("PROFILE_PIN_CHANGED", { userId: user.id, profileId: id });
  const out: ApiResponses["PUT /profiles/:id/pin"] = { ok: true };
  res.json(out);
});

profilesRouter.get("/:id/addons", requireAdmin, async (req, res) => {
  const id = uuidParam(req, "id");
  await svc.getOwnedProfile(req.auth!.userId, id);
  const [addons, access] = await Promise.all([
    prisma.addon.findMany({ where: { userId: req.auth!.ownerId }, orderBy: { sortOrder: "asc" } }),
    prisma.profileAddon.findMany({ where: { profileId: id } }),
  ]);
  const allowed = new Set(access.filter((a) => a.allowed).map((a) => a.addonId));
  const out: ApiResponses["GET /profiles/:id/addons"] = { addons: addons.map((a) => ({ ...toAddonDto(a), allowed: allowed.has(a.id) })) };
  res.json(out);
});

profilesRouter.put("/:id/addons", requireAdmin, async (req, res) => {
  const id = uuidParam(req, "id");
  const body = parseBody(ProfileAddonAccessBody, req);
  await svc.getOwnedProfile(req.auth!.userId, id);
  const valid = await prisma.addon.findMany({ where: { userId: req.auth!.ownerId, id: { in: body.allow } }, select: { id: true } });
  await prisma.$transaction([
    prisma.profileAddon.deleteMany({ where: { profileId: id } }),
    prisma.profileAddon.createMany({ data: valid.map((a) => ({ profileId: id, addonId: a.id, allowed: true })) }),
  ]);
  const out: ApiResponses["PUT /profiles/:id/addons"] = { ok: true };
  res.json(out);
});

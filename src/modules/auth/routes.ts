import { Router } from "express";
import { ChangePasswordBody, LoginBody, RefreshBody, RegisterAdminBody, type ApiResponses } from "../../contracts/api.js";
import { prisma } from "../../db/prisma.js";
import { toProfileDto, toUserDto } from "../../lib/dto.js";
import { audit } from "../../lib/audit.js";
import { authenticate, loadProfile } from "../../middleware/auth.js";
import { loginLimiter, refreshLimiter, setupLimiter } from "../../middleware/rate-limit.js";
import { parseBody } from "../../middleware/validate.js";
import * as svc from "./service.js";
import { clientMeta, revokeRefreshToken } from "./session.js";

export const authRouter = Router();

authRouter.get("/bootstrap", async (_req, res) => {
  const out: ApiResponses["GET /auth/bootstrap"] = { registrationOpen: await svc.isRegistrationOpen() };
  res.json(out);
});

authRouter.post("/register-admin", setupLimiter, async (req, res) => {
  const body = parseBody(RegisterAdminBody, req);
  const r = await svc.registerAdmin(body, clientMeta(req, body.deviceName));
  const out: ApiResponses["POST /auth/register-admin"] = { user: toUserDto(r.user), profiles: r.profiles.map(toProfileDto), tokens: r.tokens };
  res.status(201).json(out);
});

authRouter.post("/login", loginLimiter, async (req, res) => {
  const body = parseBody(LoginBody, req);
  const r = await svc.login(body, clientMeta(req, body.deviceName));
  const out: ApiResponses["POST /auth/login"] = { user: toUserDto(r.user), profiles: r.profiles.map(toProfileDto), tokens: r.tokens };
  res.json(out);
});

authRouter.post("/refresh", refreshLimiter, async (req, res) => {
  const body = parseBody(RefreshBody, req);
  const out: ApiResponses["POST /auth/refresh"] = await svc.refresh(body.refreshToken, clientMeta(req));
  res.json(out);
});

authRouter.post("/logout", authenticate, async (req, res) => {
  const body = parseBody(RefreshBody, req);
  await revokeRefreshToken(req.auth!.userId, body.refreshToken);
  audit("LOGOUT", { userId: req.auth!.userId, ip: req.ip });
  const out: ApiResponses["POST /auth/logout"] = { ok: true };
  res.json(out);
});

authRouter.post("/logout-all", authenticate, async (req, res) => {
  const { revoked } = await svc.revokeAllSessions(req.auth!.userId);
  audit("LOGOUT", { userId: req.auth!.userId, ip: req.ip, meta: { all: true } });
  const out: ApiResponses["POST /auth/logout-all"] = { ok: true, revokedSessions: revoked };
  res.json(out);
});

authRouter.get("/me", authenticate, async (req, res) => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.auth!.userId } });
  const profile = req.auth!.profileId ? await loadProfile(req.auth!.profileId) : null;
  const out: ApiResponses["GET /auth/me"] = { user: toUserDto(user), activeProfile: profile ? toProfileDto(profile) : null };
  res.json(out);
});

authRouter.post("/change-password", authenticate, async (req, res) => {
  const body = parseBody(ChangePasswordBody, req);
  const { tokens } = await svc.changePassword(req.auth!.userId, body.currentPassword, body.newPassword, req.auth!.profileId, clientMeta(req));
  const out: ApiResponses["POST /auth/change-password"] = { ok: true, tokens };
  res.json(out);
});

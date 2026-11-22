import type { NextFunction, Request, Response } from "express";
import { LRUCache } from "lru-cache";
import type { Profile, User } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { AppError, forbidden } from "../lib/errors.js";
import { verifyAccessToken } from "../lib/jwt.js";
import { UNRESTRICTED_POLICY, type ParentalPolicy } from "../lib/maturity.js";
import type { ProfileContext } from "../types/express.js";

/* Short-lived caches; explicitly invalidated on mutation. */
const userCache = new LRUCache<string, User>({ max: 500, ttl: 15_000 });
const profileCache = new LRUCache<string, Profile>({ max: 1000, ttl: 15_000 });

export const invalidateUser = (id: string) => userCache.delete(id);
export const invalidateProfile = (id: string) => profileCache.delete(id);

async function loadUser(id: string) {
  let u = userCache.get(id);
  if (!u) {
    u = (await prisma.user.findUnique({ where: { id } })) ?? undefined;
    if (u) userCache.set(id, u);
  }
  return u;
}

export async function loadProfile(id: string) {
  let p = profileCache.get(id);
  if (!p) {
    p = (await prisma.profile.findUnique({ where: { id } })) ?? undefined;
    if (p) profileCache.set(id, p);
  }
  return p;
}

export function policyFor(p: Profile): ParentalPolicy {
  if (p.kind === "OWNER") return UNRESTRICTED_POLICY;
  return {
    restricted: true,
    maturityCap: p.maturityCap,
    hideUnrated: p.hideUnrated,
    hideAdultAddons: p.hideAdultAddons,
    allowMagnetInput: p.allowMagnetInput,
    allowAddonInstall: p.allowAddonInstall,
    addonAllowlistOnly: p.addonAllowlistOnly,
  };
}

/** Requires a valid Bearer access token; populates req.auth. */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ")) throw new AppError("UNAUTHENTICATED", "Missing bearer token");
  const claims = verifyAccessToken(h.slice(7));
  const user = await loadUser(claims.sub);
  if (!user || user.tokenVersion !== claims.tv) throw new AppError("UNAUTHENTICATED", "Session revoked");
  if (user.isLocked) throw new AppError("ACCOUNT_LOCKED", "Account is locked");

  req.auth = {
    userId: user.id,
    role: user.role,
    tokenVersion: user.tokenVersion,
    ownerId: user.role === "ADMIN" ? user.id : (user.ownerId ?? user.id),
    profileId: claims.pid ?? null,
    profileKind: claims.pkind ?? null,
  };
  next();
}

/** Requires an active profile; populates req.profileCtx with the parental policy. */
export async function requireProfile(req: Request, _res: Response, next: NextFunction) {
  const a = req.auth;
  if (!a) throw new AppError("UNAUTHENTICATED", "Not authenticated");
  if (!a.profileId) throw new AppError("PROFILE_REQUIRED", "Select a profile first");
  const profile = await loadProfile(a.profileId);
  if (!profile || profile.userId !== a.userId) throw new AppError("PROFILE_REQUIRED", "Profile no longer exists");
  if (profile.isLocked) throw new AppError("FORBIDDEN", "This profile is locked");
  req.profileCtx = { profile, policy: policyFor(profile) };
  next();
}

/** ADMIN account acting through its OWNER profile. Children (even sub-profiles of the admin) are rejected. */
export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  await requireProfile(req, res, () => undefined);
  if (req.auth!.role !== "ADMIN" || req.profileCtx!.profile.kind !== "OWNER") throw forbidden("Admin profile required");
  next();
}

/** Child profile must have the given capability flag enabled. */
export const requireFlag =
  (flag: "allowMagnetInput" | "allowAddonInstall") => async (req: Request, res: Response, next: NextFunction) => {
    await requireProfile(req, res, () => undefined);
    if (!req.profileCtx!.policy[flag]) throw forbidden("This profile isn't allowed to do that");
    next();
  };

export const ctx = (req: Request): ProfileContext & { ownerId: string; userId: string } => {
  if (!req.auth || !req.profileCtx) throw new AppError("PROFILE_REQUIRED", "Select a profile first");
  return { ...req.profileCtx, ownerId: req.auth.ownerId, userId: req.auth.userId };
};

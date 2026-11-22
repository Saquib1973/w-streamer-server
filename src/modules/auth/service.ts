import { timingSafeEqual, createHash } from "node:crypto";
import { Prisma, type User } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { env } from "../../config/env.js";
import type { LoginBody, RegisterAdminBody } from "../../contracts/api.js";
import { AppError } from "../../lib/errors.js";
import { burnVerifyTime, hashSecret, verifySecret } from "../../lib/crypto/password.js";
import { hashRefreshToken } from "../../lib/jwt.js";
import { audit } from "../../lib/audit.js";
import { logger } from "../../lib/logger.js";
import { invalidateUser } from "../../middleware/auth.js";
import { issueSession, type ClientMeta } from "./session.js";
import { installBuiltinAddons } from "../addons/service.js";

const MAX_LOGIN_FAILURES = 8;
const LOGIN_LOCK_MS = 15 * 60_000;
/** Concurrent refreshes from the same device within this window don't trigger reuse detection. */
const ROTATION_GRACE_MS = 10_000;

const sha = (s: string) => createHash("sha256").update(s).digest();

export async function isRegistrationOpen(): Promise<boolean> {
  const [state, adminCount] = await Promise.all([
    prisma.systemState.findUnique({ where: { id: 1 } }),
    prisma.user.count({ where: { role: "ADMIN" } }),
  ]);
  return !state?.registrationLocked && adminCount === 0;
}

export async function registerAdmin(body: RegisterAdminBody, meta: ClientMeta) {
  if (!timingSafeEqual(sha(body.setupToken), sha(env.ADMIN_SETUP_TOKEN)))
    throw new AppError("FORBIDDEN", "Invalid setup token");

  const passwordHash = await hashSecret(body.password);
  const pinHash = await hashSecret(body.ownerPin);

  const { user, profile } = await prisma
    .$transaction(
      async (tx) => {
        const state = await tx.systemState.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
        const admins = await tx.user.count({ where: { role: "ADMIN" } });
        if (state.registrationLocked || state.adminSeededAt || admins > 0)
          throw new AppError("REGISTRATION_LOCKED", "Registration is closed");

        const user = await tx.user.create({
          data: { username: body.username, email: body.email ?? null, passwordHash, role: "ADMIN", lastLoginAt: new Date() },
        });
        const profile = await tx.profile.create({
          data: { userId: user.id, name: user.username.slice(0, 40), kind: "OWNER", pinHash, maturityCap: "NC_17" },
        });
        await tx.systemState.update({ where: { id: 1 }, data: { registrationLocked: true, adminSeededAt: new Date() } });
        return { user, profile };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    )
    .catch((e: unknown) => {
      // Serialization failure from a concurrent registration attempt
      if (e instanceof Prisma.PrismaClientKnownRequestError && (e.code === "P2034" || e.code === "P2002"))
        throw new AppError("REGISTRATION_LOCKED", "Registration is closed");
      throw e;
    });

  audit("ADMIN_REGISTERED", { userId: user.id, ip: meta.ip });
  installBuiltinAddons(user.id).catch((err: unknown) => logger.warn({ err }, "builtin addon install failed"));

  const { tokens } = await issueSession(user, profile, meta);
  return { user, profiles: [profile], tokens };
}

export async function login(body: LoginBody, meta: ClientMeta) {
  const ident = body.identifier.trim();
  const user = await prisma.user.findFirst({
    where: ident.includes("@") ? { email: ident } : { username: ident },
  });

  if (!user) {
    await burnVerifyTime(body.password);
    audit("LOGIN_FAILED", { ip: meta.ip, meta: { identifier: ident.slice(0, 64) } });
    throw new AppError("INVALID_CREDENTIALS", "Incorrect username or password");
  }
  if (user.lockedUntil && user.lockedUntil > new Date())
    throw new AppError("ACCOUNT_LOCKED", "Too many failed attempts. Try again later.", { until: user.lockedUntil.toISOString() });

  const ok = await verifySecret(user.passwordHash, body.password);
  if (!ok) {
    const failures = user.failedLoginCount + 1;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: failures >= MAX_LOGIN_FAILURES ? 0 : failures,
        lockedUntil: failures >= MAX_LOGIN_FAILURES ? new Date(Date.now() + LOGIN_LOCK_MS) : null,
      },
    });
    audit("LOGIN_FAILED", { userId: user.id, ip: meta.ip });
    throw new AppError("INVALID_CREDENTIALS", "Incorrect username or password");
  }
  if (user.isLocked) throw new AppError("ACCOUNT_LOCKED", "This account has been locked by the administrator");

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
  });
  invalidateUser(user.id);

  const profiles = await prisma.profile.findMany({ where: { userId: user.id }, orderBy: [{ kind: "desc" }, { sortOrder: "asc" }] });
  // No profile picker: every login goes straight into the account's own profile.
  const autoProfile = (updated.role === "ADMIN" ? profiles.find((p) => p.kind === "OWNER") : profiles[0]) ?? profiles[0] ?? null;

  audit("LOGIN_SUCCESS", { userId: user.id, ip: meta.ip, meta: { device: meta.deviceName ?? null } });
  const { tokens } = await issueSession(updated, autoProfile, meta);
  return { user: updated, profiles, tokens };
}

export async function refresh(refreshToken: string, meta: ClientMeta) {
  const tokenHash = hashRefreshToken(refreshToken);
  const row = await prisma.refreshToken.findUnique({ where: { tokenHash } });
  if (!row) throw new AppError("UNAUTHENTICATED", "Invalid refresh token");

  if (row.revokedAt) throw new AppError("UNAUTHENTICATED", "Session revoked");
  if (row.rotatedAt) {
    if (Date.now() - row.rotatedAt.getTime() < ROTATION_GRACE_MS)
      throw new AppError("TOKEN_EXPIRED", "Refresh token already rotated; retry with the newest token");
    // Reuse of a rotated token ⇒ likely theft. Kill the whole family.
    await prisma.refreshToken.updateMany({ where: { familyId: row.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
    audit("REFRESH_REUSE_DETECTED", { userId: row.userId, ip: meta.ip, meta: { familyId: row.familyId } });
    throw new AppError("UNAUTHENTICATED", "Session revoked");
  }
  if (row.expiresAt < new Date()) throw new AppError("UNAUTHENTICATED", "Session expired");

  // Atomically claim the token for rotation.
  const claimed = await prisma.refreshToken.updateMany({ where: { id: row.id, rotatedAt: null, revokedAt: null }, data: { rotatedAt: new Date() } });
  if (claimed.count === 0) throw new AppError("TOKEN_EXPIRED", "Refresh token already rotated; retry with the newest token");

  const user = await prisma.user.findUnique({ where: { id: row.userId } });
  if (!user || user.isLocked) throw new AppError("UNAUTHENTICATED", "Account unavailable");
  const profile = row.profileId ? await prisma.profile.findUnique({ where: { id: row.profileId } }) : null;

  const { tokens, refreshTokenId } = await issueSession(
    user,
    profile && profile.userId === user.id && !profile.isLocked ? profile : null,
    { ...meta, deviceName: meta.deviceName ?? row.deviceName },
    row.familyId,
  );
  await prisma.refreshToken.update({ where: { id: row.id }, data: { replacedById: refreshTokenId } });
  return { tokens };
}

/** Bumps tokenVersion (invalidates all access tokens) and revokes all refresh tokens. */
export async function revokeAllSessions(userId: string): Promise<{ user: User; revoked: number }> {
  const [user, r] = await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { tokenVersion: { increment: 1 } } }),
    prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);
  invalidateUser(userId);
  return { user, revoked: r.count };
}

export async function changePassword(userId: string, current: string, next: string, profileId: string | null, meta: ClientMeta) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!(await verifySecret(user.passwordHash, current))) throw new AppError("INVALID_CREDENTIALS", "Current password is incorrect");
  await prisma.user.update({ where: { id: userId }, data: { passwordHash: await hashSecret(next) } });
  const { user: bumped } = await revokeAllSessions(userId);
  const profile = profileId ? await prisma.profile.findUnique({ where: { id: profileId } }) : null;
  return issueSession(bumped, profile, meta);
}

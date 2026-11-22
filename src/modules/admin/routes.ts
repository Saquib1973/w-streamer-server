import { Router } from "express";
import type { AuditAction, Prisma } from "@prisma/client";
import { CreateChildAccountBody, UpdateChildAccountBody, type ApiResponses, type ChildAccountDto } from "../../contracts/api.js";
import { prisma } from "../../db/prisma.js";
import { toProfileDto, toUserDto } from "../../lib/dto.js";
import { audit } from "../../lib/audit.js";
import { hashSecret } from "../../lib/crypto/password.js";
import { notFound } from "../../lib/errors.js";
import { authenticate, invalidateProfile, invalidateUser, requireAdmin } from "../../middleware/auth.js";
import { parseBody, uuidParam } from "../../middleware/validate.js";
import { profileData } from "../profiles/service.js";
import { revokeAllSessions } from "../auth/service.js";

export const adminRouter = Router();
adminRouter.use(authenticate, requireAdmin);

async function loadChild(adminId: string, userId: string) {
  const u = await prisma.user.findUnique({ where: { id: userId }, include: { profiles: true } });
  if (!u || u.ownerId !== adminId || u.role !== "CHILD") throw notFound("Child account");
  return u;
}

const toChildDto = (u: Awaited<ReturnType<typeof loadChild>>): ChildAccountDto => ({
  user: toUserDto(u),
  profile: toProfileDto(u.profiles[0]!),
});

adminRouter.get("/child-accounts", async (req, res) => {
  const users = await prisma.user.findMany({
    where: { ownerId: req.auth!.userId, role: "CHILD" },
    include: { profiles: true },
    orderBy: { createdAt: "asc" },
  });
  const out: ApiResponses["GET /admin/child-accounts"] = { accounts: users.filter((u) => u.profiles.length).map(toChildDto) };
  res.json(out);
});

adminRouter.post("/child-accounts", async (req, res) => {
  const body = parseBody(CreateChildAccountBody, req);
  const passwordHash = await hashSecret(body.password);
  const pinHash = body.profile.pin ? await hashSecret(body.profile.pin) : null;
  const user = await prisma.user.create({
    data: {
      username: body.username,
      passwordHash,
      role: "CHILD",
      ownerId: req.auth!.userId,
      profiles: {
        create: {
          ...(profileData(body.profile) as Omit<Prisma.ProfileUncheckedCreateWithoutUserInput, "name" | "kind">),
          name: body.profile.name,
          kind: "CHILD",
          pinHash,
        },
      },
    },
    include: { profiles: true },
  });
  audit("CHILD_ACCOUNT_CREATED", { userId: req.auth!.userId, meta: { childUserId: user.id } });
  const out: ApiResponses["POST /admin/child-accounts"] = { account: toChildDto(user) };
  res.status(201).json(out);
});

adminRouter.patch("/child-accounts/:userId", async (req, res) => {
  const id = uuidParam(req, "userId");
  const body = parseBody(UpdateChildAccountBody, req);
  const child = await loadChild(req.auth!.userId, id);

  if (body.password) await prisma.user.update({ where: { id }, data: { passwordHash: await hashSecret(body.password) } });
  if (body.isLocked !== undefined) await prisma.user.update({ where: { id }, data: { isLocked: body.isLocked } });
  if (body.password || body.isLocked) await revokeAllSessions(id);
  if (body.profile && child.profiles[0]) {
    const data = profileData(body.profile);
    if (body.profile.pin) data.pinHash = await hashSecret(body.profile.pin);
    await prisma.profile.update({ where: { id: child.profiles[0].id }, data });
    invalidateProfile(child.profiles[0].id);
  }
  invalidateUser(id);
  audit("CHILD_ACCOUNT_UPDATED", { userId: req.auth!.userId, meta: { childUserId: id } });
  const out: ApiResponses["PATCH /admin/child-accounts/:userId"] = { account: toChildDto(await loadChild(req.auth!.userId, id)) };
  res.json(out);
});

adminRouter.delete("/child-accounts/:userId", async (req, res) => {
  const id = uuidParam(req, "userId");
  const child = await loadChild(req.auth!.userId, id);
  await prisma.user.delete({ where: { id } });
  invalidateUser(id);
  child.profiles.forEach((p) => invalidateProfile(p.id));
  audit("CHILD_ACCOUNT_DELETED", { userId: req.auth!.userId, meta: { childUserId: id, username: child.username } });
  const out: ApiResponses["DELETE /admin/child-accounts/:userId"] = { ok: true };
  res.json(out);
});

/** Usage analytics for the admin and every member account. */
adminRouter.get("/analytics", async (req, res) => {
  const adminId = req.auth!.userId;
  const users = await prisma.user.findMany({ where: { OR: [{ id: adminId }, { ownerId: adminId }] }, orderBy: { createdAt: "asc" } });
  const userIds = users.map((u) => u.id);
  const profiles = await prisma.profile.findMany({ where: { userId: { in: userIds } }, select: { id: true, userId: true } });
  const profileUser = new Map(profiles.map((p) => [p.id, p.userId]));
  const [progress, sessions, library] = await Promise.all([
    prisma.watchProgress.findMany({ where: { profileId: { in: profiles.map((p) => p.id) } }, orderBy: { updatedAt: "desc" }, take: 5000 }),
    prisma.refreshToken.groupBy({ by: ["userId"], where: { userId: { in: userIds }, revokedAt: null, rotatedAt: null, expiresAt: { gt: new Date() } }, _count: { _all: true } }),
    prisma.libraryItem.findMany({ where: { profileId: { in: profiles.map((p) => p.id) } }, select: { profileId: true, metaId: true, name: true } }),
  ]);
  const nameOf = new Map(library.map((l) => [`${l.profileId}:${l.metaId}`, l.name]));
  const sessionCount = new Map(sessions.map((s) => [s.userId, s._count._all]));
  const since7 = Date.now() - 7 * 86_400_000;
  const dayKey = (d: Date) => d.toISOString().slice(0, 10);
  const daily = new Map<string, number>();
  for (let i = 13; i >= 0; i--) daily.set(dayKey(new Date(Date.now() - i * 86_400_000)), 0);

  const per = new Map<string, { watch: number; titles: Set<string>; episodes: number; last: (typeof progress)[number] | null }>();
  for (const p of progress) {
    const uid = profileUser.get(p.profileId);
    if (!uid) continue;
    const u = per.get(uid) ?? { watch: 0, titles: new Set<string>(), episodes: 0, last: null };
    u.watch += Math.min(p.positionSec, p.durationSec || p.positionSec);
    u.titles.add(p.metaId);
    if (p.type === "series") u.episodes++;
    u.last ??= p;
    per.set(uid, u);
    const k = dayKey(p.updatedAt);
    if (daily.has(k)) daily.set(k, daily.get(k)! + Math.min(p.positionSec, p.durationSec || p.positionSec));
  }
  const byId = new Map(users.map((u) => [u.id, u]));
  const out: ApiResponses["GET /admin/analytics"] = {
    totals: {
      users: users.length,
      activeLast7d: users.filter((u) => (u.lastLoginAt && u.lastLoginAt.getTime() > since7) || (per.get(u.id)?.last?.updatedAt.getTime() ?? 0) > since7).length,
      watchSeconds: [...per.values()].reduce((a, u) => a + u.watch, 0),
      titlesWatched: new Set(progress.map((p) => p.metaId)).size,
      plays: progress.length,
    },
    users: users.map((u) => {
      const s = per.get(u.id);
      const last = s?.last;
      return {
        id: u.id,
        username: u.username,
        role: u.role,
        isLocked: u.isLocked,
        createdAt: u.createdAt.toISOString(),
        lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
        activeSessions: sessionCount.get(u.id) ?? 0,
        watchSeconds: Math.round(s?.watch ?? 0),
        titlesWatched: s?.titles.size ?? 0,
        episodesWatched: s?.episodes ?? 0,
        lastWatched: last ? { metaId: last.metaId, name: nameOf.get(`${last.profileId}:${last.metaId}`) ?? last.metaId, at: last.updatedAt.toISOString() } : null,
      };
    }),
    recent: progress.slice(0, 40).map((p) => {
      const uid = profileUser.get(p.profileId)!;
      return {
        userId: uid,
        username: byId.get(uid)?.username ?? "?",
        metaId: p.metaId,
        name: nameOf.get(`${p.profileId}:${p.metaId}`) ?? p.metaId,
        videoId: p.videoId,
        season: p.season,
        episode: p.episode,
        positionSec: p.positionSec,
        durationSec: p.durationSec,
        at: p.updatedAt.toISOString(),
      };
    }),
    daily: [...daily.entries()].map(([day, watchSeconds]) => ({ day, watchSeconds: Math.round(watchSeconds) })),
  };
  res.json(out);
});

adminRouter.get("/audit", async (req, res) => {
  const cursor = typeof req.query.cursor === "string" && /^\d+$/.test(req.query.cursor) ? BigInt(req.query.cursor) : undefined;
  const action = typeof req.query.action === "string" ? (req.query.action as AuditAction) : undefined;
  const childIds = (await prisma.user.findMany({ where: { ownerId: req.auth!.userId }, select: { id: true } })).map((u) => u.id);
  const rows = await prisma.auditLog.findMany({
    where: { userId: { in: [req.auth!.userId, ...childIds] }, ...(action ? { action } : {}), ...(cursor ? { id: { lt: cursor } } : {}) },
    orderBy: { id: "desc" },
    take: 51,
  });
  const page = rows.slice(0, 50);
  const out: ApiResponses["GET /admin/audit"] = {
    items: page.map((r) => ({ id: r.id.toString(), action: r.action, createdAt: r.createdAt.toISOString(), meta: r.meta })),
    nextCursor: rows.length > 50 ? page[page.length - 1]!.id.toString() : null,
  };
  res.json(out);
});

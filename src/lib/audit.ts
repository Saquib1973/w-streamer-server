import type { AuditAction, Prisma } from "@prisma/client";
import { prisma } from "../db/prisma.js";
import { logger } from "./logger.js";

/** Fire-and-forget audit write; never fails the request. */
export function audit(action: AuditAction, o: { userId?: string | null; profileId?: string | null; ip?: string | null; meta?: Prisma.InputJsonValue } = {}) {
  prisma.auditLog
    .create({ data: { action, userId: o.userId ?? null, profileId: o.profileId ?? null, ipAddress: o.ip ?? null, meta: o.meta } })
    .catch((e: unknown) => logger.warn({ err: e, action }, "audit write failed"));
}

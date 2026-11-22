import { randomUUID } from "node:crypto";
import type { Profile, User } from "@prisma/client";
import type { Request } from "express";
import { prisma } from "../../db/prisma.js";
import type { TokenPair } from "../../contracts/api.js";
import { hashRefreshToken, newRefreshToken, refreshExpiry, signAccessToken } from "../../lib/jwt.js";

export interface ClientMeta {
  deviceName?: string | null;
  userAgent?: string | null;
  ip?: string | null;
}

export const clientMeta = (req: Request, deviceName?: string | null): ClientMeta => ({
  deviceName: deviceName ?? null,
  userAgent: req.get("user-agent")?.slice(0, 255) ?? null,
  ip: req.ip ?? null,
});

/** Creates a refresh token row (new family unless given) and a matching access token. */
export async function issueSession(
  user: Pick<User, "id" | "role" | "tokenVersion">,
  profile: Pick<Profile, "id" | "kind"> | null,
  meta: ClientMeta,
  familyId: string = randomUUID(),
): Promise<{ tokens: TokenPair; refreshTokenId: string }> {
  const refreshToken = newRefreshToken();
  const expiresAt = refreshExpiry();
  const row = await prisma.refreshToken.create({
    data: {
      userId: user.id,
      profileId: profile?.id ?? null,
      tokenHash: hashRefreshToken(refreshToken),
      familyId,
      deviceName: meta.deviceName ?? null,
      userAgent: meta.userAgent ?? null,
      ipAddress: meta.ip ?? null,
      expiresAt,
    },
  });
  const access = signAccessToken({
    userId: user.id,
    role: user.role,
    tokenVersion: user.tokenVersion,
    profileId: profile?.id,
    profileKind: profile?.kind,
  });
  return {
    refreshTokenId: row.id,
    tokens: {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt.toISOString(),
      refreshToken,
      refreshTokenExpiresAt: expiresAt.toISOString(),
    },
  };
}

export async function revokeRefreshToken(userId: string, refreshToken: string) {
  await prisma.refreshToken.updateMany({
    where: { userId, tokenHash: hashRefreshToken(refreshToken), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

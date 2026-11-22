import { createHash, randomBytes, timingSafeEqual, createHmac } from "node:crypto";
import jwt from "jsonwebtoken";
import { env, durationToMs } from "../config/env.js";
import type { AccessTokenClaims, ProfileKind, StreamTokenClaims, UserRole } from "../contracts/api.js";
import { AppError } from "./errors.js";

const ISSUER = "wstreamer";

export interface AccessInput {
  userId: string;
  role: UserRole;
  tokenVersion: number;
  profileId?: string | null;
  profileKind?: ProfileKind | null;
}

export function signAccessToken(i: AccessInput): { token: string; expiresAt: Date } {
  const ttlMs = durationToMs(env.JWT_ACCESS_TTL);
  const payload: Omit<AccessTokenClaims, "iat" | "exp"> = {
    sub: i.userId,
    role: i.role,
    tv: i.tokenVersion,
    typ: "access",
    ...(i.profileId ? { pid: i.profileId, pkind: i.profileKind ?? undefined } : {}),
  };
  const token = jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    algorithm: "HS256",
    expiresIn: Math.floor(ttlMs / 1000),
    issuer: ISSUER,
  });
  return { token, expiresAt: new Date(Date.now() + ttlMs) };
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  try {
    const c = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ["HS256"], issuer: ISSUER }) as AccessTokenClaims;
    if (c.typ !== "access") throw new Error("wrong typ");
    return c;
  } catch (e) {
    if (e instanceof jwt.TokenExpiredError) throw new AppError("TOKEN_EXPIRED", "Access token expired");
    throw new AppError("UNAUTHENTICATED", "Invalid access token");
  }
}

/* ─── Refresh tokens: opaque random, stored as keyed SHA-256 ─── */

export const newRefreshToken = () => randomBytes(32).toString("base64url");

export const hashRefreshToken = (t: string) =>
  createHash("sha256").update(env.JWT_REFRESH_SECRET).update(":").update(t).digest("hex");

export const refreshExpiry = () => new Date(Date.now() + env.JWT_REFRESH_TTL_DAYS * 86_400_000);

/* ─── Stream tokens: compact HMAC (shorter than JWT — friendlier in player URLs) ─── */

export function signStreamToken(c: Omit<StreamTokenClaims, "exp" | "typ">): string {
  const claims: StreamTokenClaims = { ...c, typ: "stream", exp: Math.floor((Date.now() + durationToMs(env.STREAM_TOKEN_TTL)) / 1000) };
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const sig = createHmac("sha256", env.STREAM_TOKEN_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyStreamToken(token: string, expectedRes: string): StreamTokenClaims {
  const [body, sig] = token.split(".");
  if (!body || !sig) throw new AppError("UNAUTHENTICATED", "Bad stream token");
  const expected = createHmac("sha256", env.STREAM_TOKEN_SECRET).update(body).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    throw new AppError("UNAUTHENTICATED", "Bad stream token");
  const claims = JSON.parse(Buffer.from(body, "base64url").toString()) as StreamTokenClaims;
  if (claims.typ !== "stream" || claims.exp * 1000 < Date.now()) throw new AppError("TOKEN_EXPIRED", "Stream token expired");
  if (claims.res !== expectedRes) throw new AppError("FORBIDDEN", "Stream token not valid for this resource");
  return claims;
}

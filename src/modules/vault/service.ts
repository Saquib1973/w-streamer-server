import type { Prisma, VaultSecret } from "@prisma/client";
import { LRUCache } from "lru-cache";
import type { PutVaultSecretBody, VaultProvider, VaultTestResultDto } from "../../contracts/api.js";
import { prisma } from "../../db/prisma.js";
import { open, seal, secretHint, vaultAad } from "../../lib/crypto/vault-cipher.js";
import { AppError } from "../../lib/errors.js";
import { audit } from "../../lib/audit.js";
import { testSecret } from "./testers.js";

/** Decrypted secrets cached briefly in memory to avoid decrypt+DB per stream request. */
const plainCache = new LRUCache<string, { secret: string; meta: Record<string, unknown> | null }>({ max: 200, ttl: 60_000 });
const cacheKey = (userId: string, provider: VaultProvider) => `${userId}:${provider}`;

export const decryptRow = (r: VaultSecret) =>
  open({ ciphertext: Buffer.from(r.ciphertext), iv: Buffer.from(r.iv), authTag: Buffer.from(r.authTag), keyVersion: r.keyVersion }, vaultAad(r.userId, r.provider, r.label));

export async function putSecret(userId: string, provider: VaultProvider, body: PutVaultSecretBody) {
  const secret = body.secret.trim();
  let test: VaultTestResultDto | null = null;
  if (body.testBeforeSave) {
    test = await testSecret(provider, secret, body.meta ?? null);
    if (!test.ok) throw new AppError("VALIDATION_FAILED", test.error ?? "Token check failed", { test });
  }
  const sealed = seal(secret, vaultAad(userId, provider, body.label));
  const meta = { ...(body.meta ?? {}), ...(test?.account ? { account: test.account } : {}) } as Prisma.InputJsonValue;
  const data = {
    ciphertext: new Uint8Array(sealed.ciphertext),
    iv: new Uint8Array(sealed.iv),
    authTag: new Uint8Array(sealed.authTag),
    keyVersion: sealed.keyVersion,
    hint: secretHint(secret),
    meta,
    isActive: body.isActive,
    lastCheckAt: test ? new Date() : null,
    lastCheckOk: test ? test.ok : null,
  };
  const entry = await prisma.vaultSecret.upsert({
    where: { userId_provider_label: { userId, provider, label: body.label } },
    create: { userId, provider, label: body.label, ...data },
    update: data,
  });
  plainCache.delete(cacheKey(userId, provider));
  audit("VAULT_SECRET_SET", { userId, meta: { provider, label: body.label } });
  return { entry, test };
}

/** Active secret for a provider (prefers label "default"). Returns null if none. */
export async function getSecret(userId: string, provider: VaultProvider): Promise<{ secret: string; meta: Record<string, unknown> | null } | null> {
  const k = cacheKey(userId, provider);
  const hit = plainCache.get(k);
  if (hit) return hit;
  const rows = await prisma.vaultSecret.findMany({ where: { userId, provider, isActive: true }, orderBy: { updatedAt: "desc" } });
  const row = rows.find((r) => r.label === "default") ?? rows[0];
  if (!row) return null;
  const v = { secret: decryptRow(row), meta: (row.meta as Record<string, unknown> | null) ?? null };
  plainCache.set(k, v);
  prisma.vaultSecret.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
  return v;
}

export async function requireSecret(userId: string, provider: VaultProvider) {
  const s = await getSecret(userId, provider);
  if (!s) throw new AppError("VAULT_SECRET_MISSING", `No ${provider} token configured in the vault`);
  return s;
}

export async function testStored(userId: string, id: string) {
  const row = await prisma.vaultSecret.findUnique({ where: { id } });
  if (!row || row.userId !== userId) throw new AppError("NOT_FOUND", "Vault entry not found");
  const result = await testSecret(row.provider, decryptRow(row), (row.meta as Record<string, unknown> | null) ?? null);
  await prisma.vaultSecret.update({ where: { id }, data: { lastCheckAt: new Date(), lastCheckOk: result.ok } });
  return result;
}

export async function deleteSecret(userId: string, id: string) {
  const row = await prisma.vaultSecret.findUnique({ where: { id } });
  if (!row || row.userId !== userId) throw new AppError("NOT_FOUND", "Vault entry not found");
  await prisma.vaultSecret.delete({ where: { id } });
  plainCache.delete(cacheKey(userId, row.provider));
  audit("VAULT_SECRET_DELETED", { userId, meta: { provider: row.provider, label: row.label } });
}

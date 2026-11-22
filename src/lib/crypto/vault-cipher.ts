import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env, vaultKeys } from "../../config/env.js";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;

export interface SealedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  keyVersion: number;
}

/** AAD binds the ciphertext to its row identity so it can't be transplanted. */
export const vaultAad = (userId: string, provider: string, label: string) =>
  Buffer.from(`${userId}:${provider}:${label}`, "utf8");

export function seal(plaintext: string, aad: Buffer): SealedSecret {
  const keyVersion = env.VAULT_ACTIVE_KEY_VERSION;
  const key = vaultKeys.get(keyVersion)!;
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag(), keyVersion };
}

export function open(sealed: SealedSecret, aad: Buffer): string {
  const key = vaultKeys.get(sealed.keyVersion);
  if (!key) throw new Error(`Vault key v${sealed.keyVersion} not configured`);
  const decipher = createDecipheriv(ALGO, key, sealed.iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(sealed.authTag);
  return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString("utf8");
}

/** "…a9F2" */
export const secretHint = (s: string) => (s.length <= 6 ? "…" : "…" + s.slice(-4));

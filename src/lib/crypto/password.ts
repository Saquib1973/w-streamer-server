import argon2 from "argon2";

/** OWASP 2024 argon2id baseline: m=19 MiB, t=2, p=1. */
const OPTS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const hashSecret = (plain: string) => argon2.hash(plain, OPTS);

export async function verifySecret(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

/** Precomputed hash used to equalize timing when the user doesn't exist. */
let dummyHash: Promise<string> | null = null;
export async function burnVerifyTime(plain: string): Promise<void> {
  dummyHash ??= hashSecret("timing-equalizer-" + Math.random());
  await verifySecret(await dummyHash, plain);
}

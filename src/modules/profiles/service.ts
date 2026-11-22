import type { Prisma, Profile } from "@prisma/client";
import type { CreateProfileBody, UpdateProfileBody } from "../../contracts/api.js";
import { prisma } from "../../db/prisma.js";
import { AppError, notFound } from "../../lib/errors.js";
import { hashSecret, verifySecret } from "../../lib/crypto/password.js";
import { audit } from "../../lib/audit.js";
import { invalidateProfile } from "../../middleware/auth.js";

export const MAX_PROFILES = 8;
const PIN_MAX_FAILURES = 5;
const PIN_LOCK_MS = 5 * 60_000;

/** Maps API input to Prisma columns (parental fields only meaningful for CHILD). */
export function profileData(input: CreateProfileBody | UpdateProfileBody) {
  const d: Prisma.ProfileUncheckedUpdateInput = {};
  if (input.name !== undefined) d.name = input.name;
  if (input.avatar !== undefined) d.avatar = input.avatar;
  if (input.accentColor !== undefined) d.accentColor = input.accentColor;
  const p = input.parental;
  if (p) {
    if (p.maturityCap !== undefined) d.maturityCap = p.maturityCap;
    if (p.hideUnrated !== undefined) d.hideUnrated = p.hideUnrated;
    if (p.hideAdultAddons !== undefined) d.hideAdultAddons = p.hideAdultAddons;
    if (p.allowMagnetInput !== undefined) d.allowMagnetInput = p.allowMagnetInput;
    if (p.allowAddonInstall !== undefined) d.allowAddonInstall = p.allowAddonInstall;
    if (p.addonAllowlistOnly !== undefined) d.addonAllowlistOnly = p.addonAllowlistOnly;
  }
  if ("isLocked" in input && input.isLocked !== undefined) d.isLocked = input.isLocked;
  if ("sortOrder" in input && input.sortOrder !== undefined) d.sortOrder = input.sortOrder;
  if ("preferences" in input && input.preferences) {
    const pr = input.preferences;
    if (pr.preferredAudioLang !== undefined) d.preferredAudioLang = pr.preferredAudioLang;
    if (pr.preferredSubLang !== undefined) d.preferredSubLang = pr.preferredSubLang;
    if (pr.autoplayNext !== undefined) d.autoplayNext = pr.autoplayNext;
  }
  return d;
}

export async function createChildProfile(userId: string, body: CreateProfileBody) {
  const count = await prisma.profile.count({ where: { userId } });
  if (count >= MAX_PROFILES) throw new AppError("CONFLICT", `Maximum of ${MAX_PROFILES} profiles reached`);
  const profile = await prisma.profile.create({
    data: {
      ...(profileData(body) as Prisma.ProfileUncheckedCreateInput),
      name: body.name,
      userId,
      kind: "CHILD",
      sortOrder: count,
      pinHash: body.pin ? await hashSecret(body.pin) : null,
    },
  });
  audit("PROFILE_CREATED", { userId, profileId: profile.id });
  return profile;
}

export async function getOwnedProfile(userId: string, id: string): Promise<Profile> {
  const p = await prisma.profile.findUnique({ where: { id } });
  if (!p || p.userId !== userId) throw notFound("Profile");
  return p;
}

export async function updateProfile(id: string, data: Prisma.ProfileUncheckedUpdateInput, pin?: string) {
  if (pin) data.pinHash = await hashSecret(pin);
  const p = await prisma.profile.update({ where: { id }, data });
  invalidateProfile(id);
  return p;
}

/** Verifies a PIN with lockout. Throws PIN_REQUIRED / PIN_INVALID / PIN_LOCKED. */
export async function checkPin(profile: Profile, pin: string | undefined, ip?: string | null) {
  if (!profile.pinHash) return;
  if (profile.pinLockedUntil && profile.pinLockedUntil > new Date())
    throw new AppError("PIN_LOCKED", "Too many wrong PINs. Try again later.", { until: profile.pinLockedUntil.toISOString() });
  if (!pin) throw new AppError("PIN_REQUIRED", "PIN required");
  if (await verifySecret(profile.pinHash, pin)) {
    if (profile.pinFailedCount) await prisma.profile.update({ where: { id: profile.id }, data: { pinFailedCount: 0, pinLockedUntil: null } });
    return;
  }
  const failures = profile.pinFailedCount + 1;
  const lock = failures >= PIN_MAX_FAILURES;
  await prisma.profile.update({
    where: { id: profile.id },
    data: { pinFailedCount: lock ? 0 : failures, pinLockedUntil: lock ? new Date(Date.now() + PIN_LOCK_MS) : null },
  });
  invalidateProfile(profile.id);
  audit("PROFILE_PIN_FAILED", { userId: profile.userId, profileId: profile.id, ip });
  throw new AppError(lock ? "PIN_LOCKED" : "PIN_INVALID", lock ? "Too many wrong PINs. Locked for 5 minutes." : "Incorrect PIN", {
    attemptsLeft: lock ? 0 : PIN_MAX_FAILURES - failures,
  });
}

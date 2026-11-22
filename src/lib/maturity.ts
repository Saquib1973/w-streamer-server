import { MATURITY_RANK, type MaturityRating } from "../contracts/api.js";

/** Maps US MPAA / TV Parental Guidelines (and common intl.) strings to the unified scale. */
const MAP: Record<string, MaturityRating> = {
  G: "G",
  "TV-Y": "G",
  "TV-Y7": "G",
  "TV-Y7-FV": "G",
  "TV-G": "G",
  U: "G",
  PG: "PG",
  "TV-PG": "PG",
  "PG-13": "PG_13",
  "TV-14": "PG_13",
  "12": "PG_13",
  "12A": "PG_13",
  "13": "PG_13",
  "15": "R",
  "16": "R",
  R: "R",
  "TV-MA": "R",
  "NC-17": "NC_17",
  "18": "NC_17",
  X: "NC_17",
};

export function normalizeRating(raw: string | null | undefined): MaturityRating | null {
  if (!raw) return null;
  return MAP[raw.trim().toUpperCase()] ?? null;
}

export interface ParentalPolicy {
  restricted: boolean; // false for OWNER profile
  maturityCap: MaturityRating;
  hideUnrated: boolean;
  hideAdultAddons: boolean;
  allowMagnetInput: boolean;
  allowAddonInstall: boolean;
  addonAllowlistOnly: boolean;
}

export const UNRESTRICTED_POLICY: ParentalPolicy = {
  restricted: false,
  maturityCap: "NC_17",
  hideUnrated: false,
  hideAdultAddons: false,
  allowMagnetInput: true,
  allowAddonInstall: true,
  addonAllowlistOnly: false,
};

export function isAllowed(policy: ParentalPolicy, rating: MaturityRating | null | undefined): boolean {
  if (!policy.restricted) return true;
  if (rating == null) return !policy.hideUnrated;
  return MATURITY_RANK[rating] <= MATURITY_RANK[policy.maturityCap];
}

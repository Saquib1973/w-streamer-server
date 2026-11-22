import type { Profile, UserRole, ProfileKind } from "@prisma/client";
import type { ParentalPolicy } from "../lib/maturity.js";

export interface AuthContext {
  userId: string;
  role: UserRole;
  tokenVersion: number;
  /** The ADMIN account that owns addons + vault for this user (self for ADMIN). */
  ownerId: string;
  profileId: string | null;
  profileKind: ProfileKind | null;
}

export interface ProfileContext {
  profile: Profile;
  policy: ParentalPolicy;
}

declare global {
  namespace Express {
    interface Request {
      /** `id` itself is declared by pino-http (string | number); we always set a string. */
      auth?: AuthContext;
      profileCtx?: ProfileContext;
    }
  }
}

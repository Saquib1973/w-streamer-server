import type { ErrorCode } from "../contracts/api.js";

const DEFAULT_STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  TOKEN_EXPIRED: 401,
  INVALID_CREDENTIALS: 401,
  FORBIDDEN: 403,
  PROFILE_REQUIRED: 403,
  PIN_REQUIRED: 403,
  PIN_INVALID: 403,
  CONTENT_RESTRICTED: 403,
  REGISTRATION_LOCKED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  ACCOUNT_LOCKED: 423,
  PIN_LOCKED: 423,
  RATE_LIMITED: 429,
  VAULT_SECRET_MISSING: 412,
  ADDON_INVALID_MANIFEST: 422,
  ADDON_UNREACHABLE: 502,
  DEBRID_ERROR: 502,
  TORRENT_METADATA_TIMEOUT: 504,
  TORRENT_LIMIT_REACHED: 503,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
    status?: number,
  ) {
    super(message);
    this.name = "AppError";
    this.status = status ?? DEFAULT_STATUS[code];
  }
}

export const notFound = (what = "Resource") => new AppError("NOT_FOUND", `${what} not found`);
export const forbidden = (msg = "You don't have permission to do that") => new AppError("FORBIDDEN", msg);

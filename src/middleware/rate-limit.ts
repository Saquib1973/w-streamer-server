import type { Request, Response } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import type { ApiError } from "../contracts/api.js";

const handler = (req: Request, res: Response) => {
  const body: ApiError = { error: { code: "RATE_LIMITED", message: "Too many requests, slow down", requestId: String(req.id) } };
  res.status(429).json(body);
};

/** Login: 10 attempts / 15 min per IP + identifier. */
export const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip ?? "")}:${String((req.body as { identifier?: string })?.identifier ?? "").toLowerCase()}`,
  handler,
});

export const setupLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 5, standardHeaders: "draft-8", legacyHeaders: false, handler });
export const refreshLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false, handler });
export const pinLimiter = rateLimit({ windowMs: 5 * 60_000, limit: 15, standardHeaders: "draft-8", legacyHeaders: false, handler });
export const apiLimiter = rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: "draft-8", legacyHeaders: false, handler });

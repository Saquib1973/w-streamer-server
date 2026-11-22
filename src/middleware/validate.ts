import type { Request } from "express";
import type { z } from "zod";
import { AppError } from "../lib/errors.js";

function run<S extends z.ZodType>(schema: S, data: unknown, where: string): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Invalid ${where}`,
      r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return r.data;
}

export const parseBody = <S extends z.ZodType>(schema: S, req: Request) => run(schema, req.body ?? {}, "request body");
export const parseQuery = <S extends z.ZodType>(schema: S, req: Request) => run(schema, req.query, "query");

/** Route param, guaranteed non-empty string. */
export function param(req: Request, name: string): string {
  const v = req.params[name];
  if (typeof v !== "string" || !v) throw new AppError("VALIDATION_FAILED", `Missing param ${name}`);
  return v;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function uuidParam(req: Request, name: string): string {
  const v = param(req, name);
  if (!UUID_RE.test(v)) throw new AppError("NOT_FOUND", "Not found");
  return v;
}

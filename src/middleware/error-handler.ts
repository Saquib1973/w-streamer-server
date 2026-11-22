import type { ErrorRequestHandler, RequestHandler } from "express";
import { Prisma } from "@prisma/client";
import type { ApiError } from "../contracts/api.js";
import { AppError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";

export const notFoundHandler: RequestHandler = (req, res) => {
  const body: ApiError = { error: { code: "NOT_FOUND", message: `No route ${req.method} ${req.path}`, requestId: String(req.id) } };
  res.status(404).json(body);
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let e: AppError;
  if (err instanceof AppError) e = err;
  else if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")
    e = new AppError("CONFLICT", "Already exists", { target: err.meta?.target });
  else if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") e = new AppError("NOT_FOUND", "Not found");
  else if (err?.type === "entity.parse.failed") e = new AppError("VALIDATION_FAILED", "Malformed JSON body");
  else if (err?.type === "entity.too.large") e = new AppError("VALIDATION_FAILED", "Request body too large", undefined, 413);
  else {
    logger.error({ err, reqId: req.id, path: req.path }, "unhandled error");
    e = new AppError("INTERNAL", "Something went wrong");
  }
  if (e.status >= 500 && e.code !== "INTERNAL") logger.warn({ code: e.code, msg: e.message, reqId: req.id }, "upstream error");
  if (res.headersSent) return void res.end();
  const body: ApiError = { error: { code: e.code, message: e.message, details: e.details, requestId: String(req.id) } };
  res.status(e.status).json(body);
};

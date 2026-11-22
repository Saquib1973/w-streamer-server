import { randomUUID } from "node:crypto";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { env } from "./config/env.js";
import { API_PREFIX, type ApiResponses } from "./contracts/api.js";
import { prisma } from "./db/prisma.js";
import { logger } from "./lib/logger.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import { apiLimiter } from "./middleware/rate-limit.js";
import { authRouter } from "./modules/auth/routes.js";
import { profilesRouter } from "./modules/profiles/routes.js";
import { adminRouter } from "./modules/admin/routes.js";
import { vaultRouter } from "./modules/vault/routes.js";
import { addonsRouter } from "./modules/addons/routes.js";
import { catalogRouter } from "./modules/catalog/routes.js";
import { streamsRouter } from "./modules/streams/routes.js";
import { torrentsRouter, streamRouter } from "./modules/torrent/routes.js";
import { libraryRouter, progressRouter } from "./modules/progress/routes.js";
import { torrentEngine } from "./modules/torrent/engine.js";

const VERSION = "0.1.0";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  if (env.TRUST_PROXY) app.set("trust proxy", env.TRUST_PROXY);

  app.use((req, res, next) => {
    req.id = (req.get("x-request-id") ?? "").slice(0, 64) || randomUUID();
    res.setHeader("x-request-id", req.id);
    next();
  });
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as express.Request).id,
      autoLogging: { ignore: (req) => req.url?.startsWith("/stream/") === true || req.url === "/health" },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info"),
      serializers: { req: (r: { method: string; url: string }) => ({ method: r.method, url: r.url.replace(/([?&]st=)[^&]+/, "$1***") }) },
    }),
  );
  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  app.use(
    cors({
      origin: env.CORS_ORIGINS === "*" ? true : env.CORS_ORIGINS.split(",").map((s) => s.trim()),
      exposedHeaders: ["x-request-id", "content-range", "accept-ranges", "content-length"],
    }),
  );

  /* ── Streaming (stream-token auth, no JSON parsing, no rate limit) ── */
  app.use("/stream", streamRouter);

  app.get("/health", async (_req, res) => {
    const db = await prisma.$queryRaw`SELECT 1`.then(() => "up" as const).catch(() => "down" as const);
    const out: ApiResponses["GET /health"] = { ok: true, version: VERSION, db, torrentEngine: torrentEngine.isUp ? "up" : "down" };
    res.status(db === "up" ? 200 : 503).json(out);
  });

  /* ── JSON API ── */
  const api = express.Router();
  api.use(express.json({ limit: "6mb" }));
  api.use(apiLimiter);
  api.use("/auth", authRouter);
  api.use("/profiles", profilesRouter);
  api.use("/admin", adminRouter);
  api.use("/vault", vaultRouter);
  api.use("/addons", addonsRouter);
  api.use("/torrents", torrentsRouter);
  api.use("/library", libraryRouter);
  api.use("/progress", progressRouter);
  api.use("/", catalogRouter); // /board /discover /catalog /search /meta
  api.use("/", streamsRouter); // /streams /subtitles /resolve
  app.use(API_PREFIX, api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

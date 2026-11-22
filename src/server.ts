import { env } from "./config/env.js";
import { createApp } from "./app.js";
import { prisma } from "./db/prisma.js";
import { logger } from "./lib/logger.js";
import { torrentEngine } from "./modules/torrent/engine.js";

async function main() {
  await prisma.$connect();
  await prisma.systemState.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });

  const app = createApp();
  const server = app.listen(env.PORT, "0.0.0.0", () => {
    logger.info(`W-Streamer API listening on :${env.PORT} (public: ${env.PUBLIC_BASE_URL})`);
  });
  // Long-lived video streams: no request timeout, generous keep-alive.
  server.requestTimeout = 0;
  server.keepAliveTimeout = 65_000;

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    server.close();
    await Promise.allSettled([torrentEngine.shutdown(), prisma.$disconnect()]);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", (err) => logger.error({ err }, "unhandled rejection"));
}

main().catch((err) => {
  logger.fatal({ err }, "failed to start");
  process.exit(1);
});

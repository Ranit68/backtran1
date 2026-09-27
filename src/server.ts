import { buildApp } from "./app.js";
import { env } from "./config/env.js";
import { closePool } from "./config/database.js";

/**
 * Standalone HTTP server (`npm run dev` / `npm start`).
 *
 * On Vercel this file is not used; see api/index.ts.
 */
async function main(): Promise<void> {
  const app = await buildApp();

  // Warm the graph in the background so the first journey request after a cold
  // start does not pay the build cost. A failure here is logged, not fatal: the
  // cache will simply be built lazily on first use.
  void (async () => {
    if (!env.hasDatabase) {
      app.log.warn("DATABASE_URL is not set. Starting without transport data; data endpoints will return DATABASE_NOT_CONFIGURED.");
      return;
    }
    try {
      const { getGraph } = await import("./services/graph.service.js");
      const graph = await getGraph();
      app.log.info(
        { nodes: graph.nodeCount, edges: graph.data.stats.edgeCount, durationMs: graph.data.stats.buildDurationMs },
        "transport graph ready",
      );
    } catch (error) {
      app.log.error({ err: error }, "graph warm-up failed; it will be retried on the first journey request");
    }
  })();

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    try {
      await app.close();
      await closePool();
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info(`listening on http://${env.HOST}:${env.PORT} (${env.NODE_ENV})`);
}

main().catch((error) => {
  console.error("[server] failed to start", error);
  process.exit(1);
});

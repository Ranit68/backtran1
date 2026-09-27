import type { FastifyInstance } from "fastify";
import { tramWithdrawn } from "../controllers/tram.controller.js";

/**
 * Retired Tram endpoints.
 *
 * Kept registered as a single wildcard so any lingering `/api/tram/*` call gets
 * an explicit 410 with the reason, rather than a 404 that looks like a typo. The
 * old per-route handlers are gone; nothing here reads the legacy Tram tables.
 *
 * `app.all` covers every method, including GET, so registering a separate GET
 * wildcard as well would collide with it at startup.
 */
export async function tramRoutes(app: FastifyInstance): Promise<void> {
  app.all("/tram/*", async () => {
    throw tramWithdrawn();
  });
}

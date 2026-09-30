import type { FastifyInstance } from "fastify";
import { getConnections } from "../controllers/connections.controller.js";

/**
 * Cross-mode connection lookup.
 *
 * Separate from the per-mode route files because it spans all four: it is the
 * question "if I take this route, what else can I catch, and when does it run",
 * which has no single mode to live under.
 */
export async function connectionRoutes(app: FastifyInstance): Promise<void> {
  app.get("/routes/:routeNo/connections", getConnections);
}

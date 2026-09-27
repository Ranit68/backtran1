import type { FastifyInstance } from "fastify";
import { graphStats, graphTransfers, planJourney } from "../controllers/journey.controller.js";

/** POST /api/journey plus the graph introspection routes. */
export async function journeyRoutes(app: FastifyInstance): Promise<void> {
  app.post("/journey", planJourney);
  app.get("/graph/stats", graphStats);
  app.get("/graph/transfers", graphTransfers);
}

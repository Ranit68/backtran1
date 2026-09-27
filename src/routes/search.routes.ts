import type { FastifyInstance } from "fastify";
import { globalSearch } from "../controllers/search.controller.js";

/** GET /api/search */
export async function searchRoutes(app: FastifyInstance): Promise<void> {
  app.get("/search", globalSearch);
}

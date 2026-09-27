import type { FastifyInstance } from "fastify";
import { health } from "../controllers/health.controller.js";

/** GET /api/health */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", health);
}

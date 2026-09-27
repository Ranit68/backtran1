import type { FastifyInstance } from "fastify";
import { getTramRoute, getTramRouteStops, listTramRoutes, searchTram } from "../controllers/tram.controller.js";

/** Tram endpoints -- specification section 15. */
export async function tramRoutes(app: FastifyInstance): Promise<void> {
  app.get("/tram/routes", listTramRoutes);
  app.get("/tram/routes/:routeNo", getTramRoute);
  app.get("/tram/routes/:routeNo/stops", getTramRouteStops);
  app.get("/tram/search", searchTram);

  // Query-parameter form, for route numbers that contain a slash.
  app.get("/tram/routes/by-number", getTramRoute);
  app.get("/tram/routes/by-number/stops", getTramRouteStops);
}

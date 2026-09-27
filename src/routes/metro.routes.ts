import type { FastifyInstance } from "fastify";
import {
  getMetroRoute,
  getMetroStation,
  listMetroRoutes,
  listMetroStations,
  metroStatus,
  searchMetro,
} from "../controllers/modes.controller.js";

/**
 * Metro endpoints -- specification section 15.
 *
 * Registered so the API surface matches the specification, but every handler
 * currently returns 501 METRO_NOT_CONFIGURED. See
 * src/repositories/metro.repository.ts for why, and for the GTFS column mapping
 * needed to switch them on.
 */
export async function metroRoutes(app: FastifyInstance): Promise<void> {
  app.get("/metro/status", metroStatus);
  app.get("/metro/stations", listMetroStations);
  app.get("/metro/stations/:stationId", getMetroStation);
  app.get("/metro/routes", listMetroRoutes);
  app.get("/metro/routes/:routeId", getMetroRoute);
  app.get("/metro/search", searchMetro);
}

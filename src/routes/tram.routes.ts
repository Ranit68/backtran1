import type { FastifyInstance } from "fastify";
import {
  getTramLegs,
  getTramRoute,
  getTramStops,
  getTramTimetable,
  listTramExcluded,
  listTramHeritage,
  listTramRoutes,
  searchTram,
  tramDiagnostics,
  tramStatus,
} from "../controllers/tram.controller.js";

/**
 * Tram endpoints.
 *
 * Previously a single wildcard answering 410 Gone. Replaced with the real
 * surface now that the tram data set is loaded and TRAM is a routable mode.
 *
 * Route ids are `TRAM5` / `TRAM25`. Because a real tram route number is `5` and
 * `25`, the by-number endpoints also accept the bare number so a client holding
 * only what a passenger would say still resolves.
 */
export async function tramRoutes(app: FastifyInstance): Promise<void> {
  app.get("/tram/status", tramStatus);
  app.get("/tram/routes", listTramRoutes);
  app.get("/tram/routes/:routeNo", getTramRoute);
  app.get("/tram/routes/:routeNo/stops", getTramStops);
  app.get("/tram/routes/:routeNo/legs", getTramLegs);
  app.get("/tram/routes/:routeNo/timetable", getTramTimetable);
  app.get("/tram/heritage", listTramHeritage);
  app.get("/tram/excluded", listTramExcluded);
  app.get("/tram/search", searchTram);
  app.get("/tram/diagnostics", tramDiagnostics);
}

import type { FastifyInstance } from "fastify";
import {
  ferryDiagnostics,
  ferryStatus,
  getFerryRoute,
  getFerryStops,
  getFerryTimetable,
  listFerryGhats,
  listFerryRoutes,
  searchFerry,
} from "../controllers/modes.controller.js";

/**
 * Ferry endpoints.
 *
 * These were registered but returned 501 FERRY_NOT_CONFIGURED, because no ferry
 * data had been supplied and the schema was therefore not invented. The data set
 * has since been supplied and imported, so the handlers now serve real rows.
 *
 * `ghats`, `search` and `diagnostics` are additions required by the current
 * specification's diagnostics section; the five original paths keep their
 * meaning and their response shape is additive, so existing clients are
 * unaffected.
 */
export async function ferryRoutes(app: FastifyInstance): Promise<void> {
  app.get("/ferry/status", ferryStatus);
  app.get("/ferry/routes", listFerryRoutes);
  app.get("/ferry/routes/:routeNo", getFerryRoute);
  app.get("/ferry/routes/:routeNo/stops", getFerryStops);
  app.get("/ferry/routes/:routeNo/timetable", getFerryTimetable);
  app.get("/ferry/ghats", listFerryGhats);
  app.get("/ferry/search", searchFerry);
  app.get("/ferry/diagnostics", ferryDiagnostics);
}

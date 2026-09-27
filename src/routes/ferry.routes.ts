import type { FastifyInstance } from "fastify";
import {
  ferryStatus,
  getFerryRoute,
  getFerryStops,
  getFerryTimetable,
  listFerryRoutes,
} from "../controllers/modes.controller.js";

/**
 * Ferry endpoints -- specification section 15.
 *
 * These four routes are reserved and registered, but every handler returns 501
 * FERRY_NOT_CONFIGURED because no ferry source data has been supplied and the
 * specification forbids inventing the schema.
 */
export async function ferryRoutes(app: FastifyInstance): Promise<void> {
  app.get("/ferry/status", ferryStatus);
  app.get("/ferry/routes", listFerryRoutes);
  app.get("/ferry/routes/:routeNo", getFerryRoute);
  app.get("/ferry/routes/:routeNo/stops", getFerryStops);
  app.get("/ferry/routes/:routeNo/timetable", getFerryTimetable);
}

import type { FastifyInstance } from "fastify";
import {
  getMetroRoute,
  getMetroStation,
  getMetroStationTimetable,
  listMetroRoutes,
  listMetroStations,
  listMetroTrips,
  metroDiagnostics,
  metroStatus,
  searchMetro,
} from "../controllers/modes.controller.js";

/**
 * Metro endpoints.
 *
 * Metro is a real, implemented mode in this build: the four Metro tables exist
 * and are read as-is. `/metro/routes` lists the six lines, `/metro/routes/:id`
 * returns a line's ordered stations, `/metro/routes/:line/trips` returns the
 * real scheduled trips, and `/metro/stations/:id/timetable` returns the real
 * printed departure times.
 *
 * `/metro/diagnostics` is the endpoint that states the limits of the supplied
 * data outright -- including that the Pink Line has stations but no timetable,
 * and that 64 of the 80 stations have no printed time of their own.
 */
export async function metroRoutes(app: FastifyInstance): Promise<void> {
  app.get("/metro/status", metroStatus);
  app.get("/metro/diagnostics", metroDiagnostics);
  app.get("/metro/stations", listMetroStations);
  app.get("/metro/stations/:stationId", getMetroStation);
  app.get("/metro/stations/:stationId/timetable", getMetroStationTimetable);
  app.get("/metro/routes", listMetroRoutes);
  // Registered before `/:routeId` so "trips" is never read as a line code.
  app.get("/metro/routes/:line/trips", listMetroTrips);
  app.get("/metro/routes/:routeId", getMetroRoute);
  app.get("/metro/search", searchMetro);
}

import type { FastifyInstance } from "fastify";
import {
  busDiagnostics,
  getBusRoute,
  getBusRouteStops,
  getBusTimetable,
  listBusRoutes,
  listTimetableRoutes,
  searchBus,
} from "../controllers/bus.controller.js";

/** Bus endpoints -- specification section 15. */
export async function busRoutes(app: FastifyInstance): Promise<void> {
  app.get("/bus/routes", listBusRoutes);
  app.get("/bus/routes/:routeNo", getBusRoute);
  app.get("/bus/routes/:routeNo/stops", getBusRouteStops);
  app.get("/bus/routes/:routeNo/timetable", getBusTimetable);
  app.get("/bus/search", searchBus);

  // Same three endpoints, route number in a query parameter, for route numbers
  // that contain a slash (C-14/1) and so cannot be expressed as one path
  // segment: GET /api/bus/routes/by-number?routeNo=C-14%2F1
  app.get("/bus/routes/by-number", getBusRoute);
  app.get("/bus/routes/by-number/stops", getBusRouteStops);
  app.get("/bus/routes/by-number/timetable", getBusTimetable);

  // Supporting endpoints beyond the specification's minimum list.
  app.get("/bus/timetable-routes", listTimetableRoutes);
  app.get("/bus/diagnostics", busDiagnostics);
}

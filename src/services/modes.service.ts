import * as ferryRepository from "../repositories/ferry.repository.js";
import { isMetroConfigured } from "../repositories/metro.repository.js";
import { getMetroService } from "./metro.service.js";
import { AppError, ErrorCode } from "../utils/errors.js";

/**
 * Mode facades used by the controllers.
 *
 * Metro is implemented: the four Metro tables exist in the database and hold a
 * complete station list plus 1,720 real scheduled trips, so its handlers return
 * real data.
 *
 * Ferry is still reserved with no data in this build, and keeps passing its
 * repository errors through so clients get the standard error envelope with
 * HTTP 501 rather than an empty list that would imply "Kolkata has no ferries".
 */

export const MetroService = {
  listStations: (filter: { line?: string; q?: string; limit: number; offset: number }) =>
    getMetroService().getStations(filter),
  getStation: (stationId: string) => getMetroService().getStation(stationId),
  getStationTimetable: (
    stationId: string,
    filter: { serviceDay?: string; direction?: string; from?: string; limit: number; offset: number },
  ) => getMetroService().getStationTimetable(stationId, filter),
  listRoutes: (filter: { q?: string; sort?: "line" | "stop_count" | "trip_count"; order?: "asc" | "desc"; limit: number; offset: number }) =>
    getMetroService().listRoutes(filter),
  getRoute: (routeId: string) => getMetroService().getRoute(routeId),
  listTrips: (filter: {
    line: string;
    serviceDay?: string;
    direction?: string;
    from?: string;
    limit: number;
    offset: number;
  }) => getMetroService().listTrips(filter),
  searchStations: (term: string, limit: number) => getMetroService().searchStations(term, limit),
  isConfigured: () => isMetroConfigured(),
  diagnostics: () => getMetroService().diagnostics(),
  status: () => ({
    mode: "METRO" as const,
    implemented: true as const,
    reason: null,
    requiredTables: [
      "metro_routes",
      "metro_stations",
      "metro_trips",
      "metro_timetable_checkpoints",
    ],
  }),
};

export const FerryService = {
  listRoutes: () => ferryRepository.listFerryRoutes(),
  getRoute: (routeNo: string) => ferryRepository.getFerryRoute(routeNo),
  getStops: (routeNo: string) => ferryRepository.getFerryRouteStops(routeNo),
  getTimetable: (routeNo: string) => ferryRepository.getFerryRouteTimetable(routeNo),
  isConfigured: () => ferryRepository.isFerryConfigured(),
  status: () => {
    throw new AppError(
      ErrorCode.FERRY_NOT_CONFIGURED,
      ferryRepository.FERRY_NOT_CONFIGURED_MESSAGE,
    );
  },
};

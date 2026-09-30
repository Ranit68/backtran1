import * as ferryRepository from "../repositories/ferry.repository.js";
import * as tramRepository from "../repositories/tram.repository.js";
import { isMetroConfigured } from "../repositories/metro.repository.js";
import { getMetroService } from "./metro.service.js";

/**
 * Mode facades used by the controllers.
 *
 * Metro, Ferry and Tram are all implemented against imported tables, so their
 * handlers return real data. Each facade is a thin pass-through: validation,
 * paging and diagnostics live in the repository, which keeps the controllers
 * free of data-access detail.
 *
 * Ferry and Tram degrade independently. If either data set fails to load the
 * affected facade reports that, while bus and metro routing is unaffected --
 * an optional mode must not take the whole API down.
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
  listRoutes: (filter: { status?: string; limit: number; offset: number }) =>
    ferryRepository.listFerryRoutes(filter),
  countRoutes: (status?: string) => ferryRepository.countFerryRoutes(status),
  getRoute: (routeId: string) => ferryRepository.getFerryRoute(routeId),
  getGhats: () => ferryRepository.getFerryGhats(),
  getRouteLegs: (routeId: string) => ferryRepository.getFerryRouteLegs(routeId),
  getRouteSchedules: (routeId: string) => ferryRepository.getFerryRouteSchedules(routeId),
  getRouteFare: (routeId: string) => ferryRepository.getFerryRouteFare(routeId),
  getSources: () => ferryRepository.getFerrySources(),
  searchGhats: (term: string, limit: number) => ferryRepository.searchFerryGhats(term, limit),
  isConfigured: () => ferryRepository.isFerryConfigured(),
  diagnostics: () => ferryRepository.getFerryDiagnostics(),
  requiredTables: [
    "ferry_routes",
    "ferry_ghats",
    "ferry_legs",
    "ferry_schedules",
    "ferry_fares",
    "ferry_sources",
  ] as const,
};

export const TramService = {
  listRoutes: (filter: { status?: string; limit: number; offset: number }) =>
    tramRepository.listTramRoutes(filter),
  countRoutes: (status?: string) => tramRepository.countTramRoutes(status),
  getRoute: (routeId: string) => tramRepository.getTramRoute(routeId),
  getRouteStops: (routeId: string) => tramRepository.getTramRouteStops(routeId),
  getRouteLegs: (routeId: string) => tramRepository.getTramRouteLegs(routeId),
  getRouteServices: (routeId: string) => tramRepository.getTramRouteServices(routeId),
  listHeritageServices: () => tramRepository.listTramHeritageServices(),
  listExcludedHistoricalRoutes: () => tramRepository.listTramExcludedHistoricalRoutes(),
  getSources: () => tramRepository.getTramSources(),
  searchStops: (term: string, limit: number) => tramRepository.searchTramStops(term, limit),
  isConfigured: () => tramRepository.isTramConfigured(),
  diagnostics: () => tramRepository.getTramDiagnostics(),
  requiredTables: [
    "tram_routes",
    "tram_stops",
    "tram_legs",
    "tram_services",
    "tram_heritage_services",
    "tram_excluded_historical_routes",
    "tram_sources",
  ] as const,
};

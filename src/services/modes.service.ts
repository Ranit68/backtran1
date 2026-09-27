import * as metroRepository from "../repositories/metro.repository.js";
import * as ferryRepository from "../repositories/ferry.repository.js";
import { AppError, ErrorCode } from "../utils/errors.js";

/**
 * Metro and Ferry services.
 *
 * Both modes are reserved in the API surface but carry no data in this build
 * (see the repository files for the full rationale and for the exact steps
 * needed to enable each). They pass the repository errors straight through so
 * clients receive the standard error envelope with HTTP 501 rather than an
 * empty list that would imply "Kolkata has no metro / no ferries".
 */

export const MetroService = {
  listStations: () => metroRepository.listMetroStations(),
  getStation: (stationId: string) => metroRepository.getMetroStation(stationId),
  listRoutes: () => metroRepository.listMetroRoutes(),
  getRoute: (routeId: string) => metroRepository.getMetroRoute(routeId),
  searchStations: (term: string, limit: number) => metroRepository.searchMetroStations(term, limit),
  isConfigured: () => metroRepository.isMetroConfigured(),
  status: () => ({
    mode: "METRO" as const,
    implemented: false as const,
    reason: metroRepository.METRO_NOT_CONFIGURED_MESSAGE,
    requiredTables: metroRepository.METRO_REQUIRED_TABLES,
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

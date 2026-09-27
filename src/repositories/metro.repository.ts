import { AppError, ErrorCode } from "../utils/errors.js";

/**
 * Metro is deliberately NOT implemented in this build.
 *
 * Specification section 9 and section 28 say: "Do not recreate Metro tables.
 * Use the existing Metro database implementation and GTFS-style tables already
 * present in the project, including concepts such as stops, routes, trips and
 * stop_times."
 *
 * No such implementation exists in this repository, and the decision for this
 * build was to ship Bus and Tram only. Rather than create Metro tables (which
 * the specification forbids) or silently return empty arrays (which would look
 * like "Kolkata has no metro"), every Metro entry point fails loudly with
 * METRO_NOT_CONFIGURED and a message that states exactly what is missing.
 *
 * TO ENABLE METRO LATER
 * ---------------------
 * 1. Point DATABASE_URL at the Supabase project that already holds the Metro
 *    GTFS-style tables.
 * 2. Replace the bodies of the functions below with queries against those
 *    existing tables. The expected GTFS column names are listed in
 *    REQUIRED_TABLES below so the intended mapping is unambiguous:
 *      stops       -> stop_id, stop_name, stop_lat, stop_lon
 *      routes      -> route_id, route_short_name, route_long_name, route_type
 *      trips       -> trip_id, route_id, direction_id, service_id,
 *                     departure/arrival headsign
 *      stop_times  -> trip_id, stop_id, stop_sequence, arrival_time,
 *                     departure_time
 * 3. Add the Metro stops to the graph in transport.graph.ts. They are the only
 *    records in this data set that carry coordinates, so they will also switch
 *    TransferService from name-based to distance-based transfer detection.
 *
 * Nothing here writes to the database and nothing here creates a table.
 */

export const METRO_REQUIRED_TABLES = {
  stops: ["stop_id", "stop_name", "stop_lat", "stop_lon"],
  routes: ["route_id", "route_short_name", "route_long_name", "route_type"],
  trips: ["trip_id", "route_id", "direction_id", "service_id"],
  stop_times: ["trip_id", "stop_id", "stop_sequence", "arrival_time", "departure_time"],
} as const;

export const METRO_NOT_CONFIGURED_MESSAGE =
  "Metro is not configured in this build. The specification requires reusing an existing GTFS-style " +
  "Metro implementation (stops, routes, trips, stop_times) and explicitly forbids recreating those " +
  "tables here, so no Metro data is served. This build ships Bus and Tram.";

function metroNotConfigured(): AppError {
  return new AppError(ErrorCode.METRO_NOT_CONFIGURED, METRO_NOT_CONFIGURED_MESSAGE, {
    requiredTables: METRO_REQUIRED_TABLES,
  });
}

export interface MetroStation {
  stationId: string;
  name: string;
  line: string | null;
  code: string | null;
  latitude: number | null;
  longitude: number | null;
  isInterchange: boolean;
}

/** @throws {AppError} always, with code METRO_NOT_CONFIGURED. */
export async function listMetroStations(): Promise<MetroStation[]> {
  throw metroNotConfigured();
}

/** @throws {AppError} always, with code METRO_NOT_CONFIGURED. */
export async function getMetroStation(_stationId: string): Promise<MetroStation> {
  throw metroNotConfigured();
}

/** @throws {AppError} always, with code METRO_NOT_CONFIGURED. */
export async function listMetroRoutes(): Promise<unknown[]> {
  throw metroNotConfigured();
}

/** @throws {AppError} always, with code METRO_NOT_CONFIGURED. */
export async function getMetroRoute(_routeId: string): Promise<unknown> {
  throw metroNotConfigured();
}

/** @throws {AppError} always, with code METRO_NOT_CONFIGURED. */
export async function searchMetroStations(_term: string, _limit: number): Promise<MetroStation[]> {
  throw metroNotConfigured();
}

/** Non-throwing probe so /api/health can report Metro as simply "not configured". */
export function isMetroConfigured(): boolean {
  return false;
}

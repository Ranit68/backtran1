import { AppError, ErrorCode } from "../utils/errors.js";

/**
 * Ferry is deliberately NOT implemented.
 *
 * Specification section 8: "Do not create Ferry tables yet. No ferry CSV has
 * been supplied in the current data set, so the exact Ferry schema must not be
 * invented." Section 28 repeats the instruction.
 *
 * The four Ferry endpoints in the specification's endpoint list are still
 * exposed as routes so the API surface is complete and clients can code
 * against them, but each returns FERRY_NOT_CONFIGURED with HTTP 501 rather
 * than an empty list that would falsely imply "there are no ferries".
 *
 * TO ENABLE FERRY LATER
 * ---------------------
 * 1. Supply the ferry CSV.
 * 2. Inspect its exact headers and create ferry_route_stops / ferry_timetables
 *    from those headers -- not from this file.
 * 3. Implement the functions below against those tables and register the mode
 *    in transport_modes (set enabled = true for 'FERRY').
 */

export const FERRY_NOT_CONFIGURED_MESSAGE =
  "Ferry is not implemented because no ferry source data has been supplied. The specification " +
  "forbids inventing the ferry schema, so ferry tables were not created and no ferry rows exist. " +
  "Supply the ferry CSV and the schema will be derived from its actual headers.";

function ferryNotConfigured(): AppError {
  return new AppError(ErrorCode.FERRY_NOT_CONFIGURED, FERRY_NOT_CONFIGURED_MESSAGE, {
    expectedConcepts: ["ferry_route_stops", "ferry_timetables"],
    status: "awaiting source data",
  });
}

/** @throws {AppError} always, with code FERRY_NOT_CONFIGURED. */
export async function listFerryRoutes(): Promise<unknown[]> {
  throw ferryNotConfigured();
}

/** @throws {AppError} always, with code FERRY_NOT_CONFIGURED. */
export async function getFerryRoute(_routeNo: string): Promise<unknown> {
  throw ferryNotConfigured();
}

/** @throws {AppError} always, with code FERRY_NOT_CONFIGURED. */
export async function getFerryRouteStops(_routeNo: string): Promise<unknown[]> {
  throw ferryNotConfigured();
}

/** @throws {AppError} always, with code FERRY_NOT_CONFIGURED. */
export async function getFerryRouteTimetable(_routeNo: string): Promise<unknown[]> {
  throw ferryNotConfigured();
}

/** Non-throwing probe so /api/health can report Ferry as "not configured". */
export function isFerryConfigured(): boolean {
  return false;
}

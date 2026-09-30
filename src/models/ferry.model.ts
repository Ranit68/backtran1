import type { TransportMode } from "../types/transport.js";

/**
 * Row shapes of the `ferry_*` tables, as returned by the pg driver.
 *
 * These mirror the imported columns exactly -- `route_id, route_name, operator,
 * from_ghat, to_ghat, intermediate_ghats, first_departure, last_departure,
 * frequency_minutes, fare_inr, fare_range_inr, service_days, status,
 * data_confidence`. Nothing here is derived or invented; absent values stay
 * `null` rather than becoming 0 or an empty string.
 */

export interface FerryRouteRow {
  route_id: string;
  route_name: string;
  operator: string | null;
  from_ghat: string;
  to_ghat: string;
  /** Semicolon-separated ghat names, or null when the route has no intermediates. */
  intermediate_ghats: string | null;
  /** pg returns TIME as 'HH:MM:SS'. */
  first_departure: string | null;
  last_departure: string | null;
  frequency_minutes: number | null;
  /** Null when the current fare is unverified. Must never be coerced to 0. */
  fare_inr: number | null;
  fare_range_inr: string | null;
  service_days: string | null;
  status: string | null;
  data_confidence: string | null;
}

export interface FerryGhatRow {
  ghat_id: string;
  ghat_name: string;
  ghat_code: string | null;
  /** River bank the ghat sits on, e.g. WEST / EAST. */
  side: string | null;
  status: string | null;
}

export interface FerryLegRow {
  route_id: string;
  from_ghat: string;
  to_ghat: string;
  estimated_minutes: number | null;
  direction_type: string | null;
}

export interface FerryScheduleRow {
  route_id: string;
  service_days: string | null;
  first_departure: string | null;
  last_departure: string | null;
  frequency_minutes: number | null;
  confidence: string | null;
}

export interface FerryFareRow {
  route_id: string;
  /** Null when the fare is not verified; never 0. */
  fare: number | null;
  currency: string | null;
  confidence: string | null;
  note: string | null;
}

export interface FerrySourceRow {
  source_id: string;
  publisher: string | null;
  title: string | null;
  url: string | null;
  supports: string | null;
}

export interface FerryDiagnostics {
  mode: TransportMode;
  routes: number;
  ghats: number;
  legs: number;
  schedules: number;
  operationalRoutes: number;
  suspendedRoutes: number;
  missingRouteReferences: string[];
  duplicateRouteIds: string[];
  duplicateGhatIds: string[];
  /**
   * Routes whose status is neither a known live nor a known withdrawn value.
   * Reported rather than assumed routable or excluded, so an unexpected status is
   * visible instead of silently changing what the graph serves.
   */
  routesWithInvalidStatus: string[];
  /** Leg durations below zero, which would make a journey time nonsensical. */
  legsWithNegativeDuration: string[];
  /** Headways below zero. */
  schedulesWithNegativeFrequency: string[];
  routesWithUnverifiedFare: string[];
  status: "healthy" | "degraded" | "not_loaded";
}

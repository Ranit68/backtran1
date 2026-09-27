import type { TransportMode } from "../types/transport.js";

/** Row shape of `bus_route_stops` as returned by the pg driver. */
export interface BusRouteStopRow {
  id: string;
  operator: string;
  vehicle_type: string;
  route_no: string;
  depot: string | null;
  stop_sequence_no: number;
  stop_name: string;
  created_at: Date;
}

/** Row shape of `bus_timetables` as returned by the pg driver. */
export interface BusTimetableRow {
  id: string;
  operator: string | null;
  route_no: string;
  trip_no: number;
  direction_id: number;
  origin: string | null;
  destination: string | null;
  /** pg returns TIME as 'HH:MM:SS'. */
  departure_time: string | null;
  arrival_time: string | null;
  source_image_order: number | null;
  created_at: Date;
}

/**
 * Aggregate derived from `bus_timetables` at import time.
 * avg/min/max are real observed durations (arrival - departure), never guesses.
 */
export interface RouteTripStatsRow {
  operator: string;
  route_no: string;
  mode: TransportMode;
  sample_count: number;
  avg_trip_minutes: number | null;
  min_trip_minutes: number | null;
  max_trip_minutes: number | null;
  updated_at: Date;
}

// ---------------------------------------------------------------------------
// API view models
// ---------------------------------------------------------------------------

export interface BusRouteStopView {
  id: string;
  stopName: string;
  stopSequenceNo: number;
  depot: string | null;
  /** Normalised comparison key. Derived, never stored. */
  normalizedName: string;
}

export interface BusRouteSummary {
  routeId: string;
  routeNo: string;
  mode: "BUS";
  operator: string;
  vehicleType: string;
  depot: string | null;
  stopCount: number;
  firstStop: string | null;
  lastStop: string | null;
  /**
   * Mean observed end-to-end trip duration in minutes, from the timetable.
   * null when the route has no usable timetable rows -- the API omits the
   * estimate rather than substituting a fabricated number.
   */
  averageTripMinutes: number | null;
  hasTimetable: boolean;
}

export interface BusRouteDetail extends BusRouteSummary {
  stops: BusRouteStopView[];
}

export interface BusTripView {
  id: string;
  operator: string | null;
  routeNo: string;
  tripNo: number;
  directionId: number;
  origin: string | null;
  destination: string | null;
  departureTime: string | null;
  arrivalTime: string | null;
  /** arrival - departure in minutes, null when either side is missing. */
  durationMinutes: number | null;
  sourceImageOrder: number | null;
}

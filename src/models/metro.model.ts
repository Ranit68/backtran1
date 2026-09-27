import type { TransportMode } from "../types/transport.js";

/**
 * Metro data model.
 *
 * Backed by four tables that already exist in the Supabase project and are
 * read-only to this API: `metro_routes`, `metro_stations`, `metro_trips` and
 * `metro_timetable_checkpoints`. Nothing here creates, alters or drops a table.
 *
 * Coverage is deliberately uneven in the source data and this model preserves
 * that rather than smoothing it over:
 *  - `metro_stations` is a complete ordered station list for every line.
 *  - `metro_timetable_checkpoints` only covers the stations the uploaded
 *    timetable PDFs actually print a time for, so a station can exist on a line
 *    and still have no scheduled time of its own.
 *  - The Pink Line has stations but no supplied timetable and no trips at all.
 */

/** Days of operation the supplied timetables cover. */
export type MetroServiceDay = "WEEKDAY" | "SATURDAY" | "SUNDAY";

/** Which way along the line a trip runs. */
export type MetroDirection = "UP" | "DOWN";

/** How completely a station is covered by the supplied source. */
export type MetroStationCoverage = "TIMETABLE-CHECKPOINT" | "ROUTE-STATION" | "MAP-ONLY";

/** `metro_routes` as returned by the pg driver. */
export interface MetroRouteRow {
  id: string;
  line: string;
  line_name: string;
  /** Comma-separated service days, or NULL when no timetable was supplied. */
  service_days_in_uploaded_timetables: string | null;
  coverage_note: string | null;
  created_at: Date;
}

/** `metro_stations` as returned by the pg driver. */
export interface MetroStationRow {
  id: string;
  line: string;
  /** 1-based position along the line, as supplied. */
  station_sequence: number;
  /** NULL for stations that exist only on the supplied map. */
  station_code: string | null;
  station_name: string;
  timetable_exact_checkpoint: boolean;
  coverage: string | null;
  note: string | null;
  created_at: Date;
}

/** `metro_trips` as returned by the pg driver. */
export interface MetroTripRow {
  id: string;
  trip_id: string;
  train_no: string | null;
  line: string;
  service_day: string;
  direction: string;
  origin_station_code: string | null;
  origin_station_name: string;
  departure_time: string;
  destination_station_code: string | null;
  destination_station_name: string;
  arrival_time: string;
  /** `numeric` in Postgres, always read as `::float8` so this is a number. */
  duration_minutes: number | null;
  timing_scope: string | null;
  valid_from: Date | string | null;
  source_file: string | null;
  created_at: Date;
}

/** `metro_timetable_checkpoints` as returned by the pg driver. */
export interface MetroCheckpointRow {
  id: string;
  trip_id: string;
  train_no: string | null;
  line: string;
  service_day: string;
  direction: string;
  station_code: string;
  /** Ordinal within the owning trip, not a position on the line. */
  station_sequence: number;
  station_name: string | null;
  scheduled_time: string;
  event_type: string;
  timing_scope: string | null;
  valid_from: Date | string | null;
  source_file: string | null;
  created_at: Date;
}

// ---------------------------------------------------------------------------
// Aggregates used by the graph builder
// ---------------------------------------------------------------------------

/**
 * Real end-to-end trip duration for one line and direction, averaged over the
 * trips actually supplied. The graph divides this by the line's hop count to
 * get a per-hop estimate, which is the same derivation the bus graph uses for
 * `bus_timetables`.
 */
export interface MetroLineTripStatsRow {
  line: string;
  direction: string;
  trip_count: number;
  avg_trip_minutes: number;
  min_trip_minutes: number;
  max_trip_minutes: number;
}

/**
 * Real per-hop travel time for one line, measured between consecutive
 * scheduled checkpoints inside the same run.
 *
 * This is deliberately *not* `AVG(duration_minutes) / hop_count`. That shortcut
 * is wrong for this data: most runs are full-length, but some are short-turns,
 * so dividing a full-line hop count by an average duration understates the real
 * hop time badly (it yields 1.2 min/hop on the Yellow Line and 1.6 on the
 * Purple Line, both far too fast for a metro). Measuring between consecutive
 * printed times instead gives 2.8-4.0 min/hop across the five timetabled lines.
 */
export interface MetroHopStatsRow {
  line: string;
  /** Consecutive checkpoint pairs that advanced along the line. */
  span_count: number;
  /** Line positions covered by those spans. */
  hop_count: number;
  avg_minutes_per_hop: number;
  min_minutes_per_hop: number;
  max_minutes_per_hop: number;
}

/** One station as it appears on one line, already ordered. */
export interface MetroLineStation {
  line: string;
  lineName: string;
  stationSequence: number;
  stationCode: string | null;
  stationName: string;
  hasExactCheckpoint: boolean;
  coverage: string | null;
  note: string | null;
}

// ---------------------------------------------------------------------------
// API view models
// ---------------------------------------------------------------------------

export interface MetroLineSummary {
  /** Stable public identifier, e.g. "BLUE". */
  routeId: string;
  /** The line code, e.g. "BLUE". */
  routeNo: string;
  mode: "METRO";
  operator: string;
  name: string;
  stopCount: number;
  firstStop: string | null;
  lastStop: string | null;
  /** Service days the supplied timetables cover. Empty when none were supplied. */
  serviceDays: MetroServiceDay[];
  /** How many of this line's stations have a real scheduled time. */
  stationsWithTimetable: number;
  hasTimetable: boolean;
  /** Verbatim source caveat, e.g. "Sunday PDF gives endpoint timing only". */
  coverageNote: string | null;
}

export interface MetroStationView {
  stationId: string;
  name: string;
  line: string;
  lineName: string;
  stationSequence: number;
  stationCode: string | null;
  hasTimetable: boolean;
  coverage: string | null;
  note: string | null;
  normalizedName: string;
  /** Every line this station is served by. More than one means an interchange. */
  lines: string[];
}

export interface MetroLineStationView {
  stationId: string;
  name: string;
  stationSequence: number;
  stationCode: string | null;
  hasTimetable: boolean;
  coverage: string | null;
  note: string | null;
  normalizedName: string;
}

export interface MetroLineDetail extends MetroLineSummary {
  stops: MetroLineStationView[];
  /**
   * The distinct station orderings recorded for this line. Metro lines are
   * recorded in one direction only, so this is 1. Surfaced so a client can see
   * that the order is the supplied order rather than a verified timetable order.
   */
  orderings: number;
}

export interface MetroTripView {
  tripId: string;
  trainNo: string | null;
  line: string;
  serviceDay: string;
  direction: string;
  origin: string;
  destination: string;
  departureTime: string;
  arrivalTime: string;
  durationMinutes: number | null;
  /** True when the times come from a station the timetable actually prints. */
  checkpointStations: number;
  timingScope: string | null;
  validFrom: string | null;
}

export interface MetroStationTimetableView {
  stationId: string;
  name: string;
  lines: string[];
  /** Times for this station across every line that serves it. */
  departures: {
    line: string;
    serviceDay: string;
    direction: string;
    time: string;
    destination: string | null;
    tripId: string;
    trainNo: string | null;
  }[];
  /** Stated plainly when the supplied data has no time for this station. */
  note: string | null;
}

export interface MetroSearchResult {
  name: string;
  mode: "METRO";
  /** Every line serving this station. */
  lines: string[];
  routeCount: number;
  hasTimetable: boolean;
  normalizedName: string;
  nodeId: string;
}

/** Placeholder so the ferry surface can be typed before any ferry data exists. */
export type FerryModeNote = {
  mode: TransportMode;
  implemented: false;
  reason: string;
};

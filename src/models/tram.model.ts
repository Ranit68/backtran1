import type { TransportMode } from "../types/transport.js";

/**
 * Row shapes of the `tram_*` tables, as returned by the pg driver.
 *
 * Sequence columns drive the graph: `tram_stops.stop_sequence` orders a route's
 * stops and `tram_legs.segment_sequence` orders its directed edges. Route order
 * is never reconstructed from alphabetically sorted names.
 */

export interface TramRouteRow {
  route_id: string;
  route_no: string | null;
  route_name: string | null;
  operator: string | null;
  from_terminal: string | null;
  to_terminal: string | null;
  status: string | null;
  service_type: string | null;
  /** e.g. IRREGULAR. Irregular services are not treated as fixed-frequency. */
  service_pattern: string | null;
  fare_range_inr: string | null;
  data_confidence: string | null;
  notes: string | null;
}

export interface TramStopRow {
  stop_id: string;
  route_id: string;
  stop_sequence: number | null;
  stop_name: string;
  operational: boolean | null;
  status: string | null;
}

export interface TramLegRow {
  /** Source surrogate key. Also the paging key for the bulk leg loader. */
  id: string;
  route_id: string;
  segment_sequence: number | null;
  from_stop: string;
  to_stop: string;
  direction: string | null;
}

export interface TramServiceRow {
  id: string;
  route_id: string;
  service_days: string | null;
  service_pattern: string | null;
  first_departure: string | null;
  last_departure: string | null;
  /** Null when the service is irregular and no headway is published. */
  frequency_minutes: number | null;
  confidence: string | null;
  notes: string | null;
}

export interface TramHeritageServiceRow {
  service_id: string;
  tram_name: string | null;
  service_type: string | null;
  operation_type: string | null;
  service_days: string | null;
  fare_inr: number | null;
  status: string | null;
  data_confidence: string | null;
  notes: string | null;
}

export interface TramExcludedHistoricalRouteRow {
  route_id: string;
  route_no: string | null;
  route_name: string | null;
  status: string | null;
  reason: string | null;
}

export interface TramSourceRow {
  source_id: string;
  publisher: string | null;
  title: string | null;
  date: string | null;
  url: string | null;
  supports: string | null;
}

export interface TramDiagnostics {
  mode: TransportMode;
  routes: number;
  stops: number;
  edges: number;
  operationalRoutes: number;
  suspendedRoutes: number;
  timetableRecords: number;
  heritageServices: number;
  excludedHistoricalRoutes: number;
  missingRouteReferences: string[];
  duplicateStopIds: string[];
  /**
   * Routes whose stop_sequence values are not a gapless 1..N run, which would
   * make "the order of the stops" ambiguous.
   */
  invalidStopSequences: string[];
  servicesWithNegativeFrequency: string[];
  routesWithIrregularService: string[];
  status: "healthy" | "degraded" | "not_loaded";
}

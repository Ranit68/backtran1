/**
 * Common transport model -- specification section 10, plus the graph types
 * from section 11 and the journey types from section 14.
 *
 * Nothing in this file invents data. Fields that the source data set cannot
 * supply (coordinates, distance) are optional and are omitted from responses
 * rather than guessed.
 */

export type TransportMode = "METRO" | "BUS" | "FERRY";

export const TRANSPORT_MODES: readonly TransportMode[] = ["METRO", "BUS", "FERRY"];

export function isTransportMode(value: string): value is TransportMode {
  return (TRANSPORT_MODES as readonly string[]).includes(value);
}

/**
 * Modes that used to be part of the API and are no longer served.
 *
 * Kolkata's tram service has been withdrawn, so TRAM is no longer a member of
 * TransportMode and cannot be requested from search, the graph or the journey
 * planner. It is kept here so the API can answer a client that still asks for
 * it with a precise 410 Gone instead of a confusing "no results" or a bare 404.
 */
export const RETIRED_TRANSPORT_MODES = ["TRAM"] as const;

export type RetiredTransportMode = (typeof RETIRED_TRANSPORT_MODES)[number];

export function isRetiredTransportMode(value: string): value is RetiredTransportMode {
  return (RETIRED_TRANSPORT_MODES as readonly string[]).includes(value);
}

export const TRAM_WITHDRAWAL_NOTE =
  "Kolkata's tram service has been withdrawn. TRAM is no longer a transport mode in this API: " +
  "the tram routes were removed from the transport graph, /api/tram/* returns 410 Gone, and " +
  "mode=TRAM is rejected by search and the journey planner. Use mode=METRO or mode=BUS, or " +
  "mode=ALL for combined bus and metro routing.";

export interface TransportStop {
  id: string;
  name: string;
  mode: TransportMode;
  operator?: string;
  latitude?: number;
  longitude?: number;
}

export interface TransportRoute {
  routeId: string;
  routeNo: string;
  mode: TransportMode;
  operator?: string;
  name?: string;
}

/** Specification section 11. */
export interface GraphNode {
  id: string;
  name: string;
  mode: TransportMode;
  operator?: string;
  latitude?: number;
  longitude?: number;
}

export type GraphEdgeMode = TransportMode | "TRANSFER" | "WALK";

export interface GraphEdge {
  fromNodeId: string;
  toNodeId: string;
  mode: GraphEdgeMode;
  routeId?: string;
  routeNo?: string;
  operator?: string;
  distanceMeters?: number;
  estimatedTimeMinutes?: number;
  transferTimeMinutes?: number;
}

/** The mode a graph edge represents, narrowed to a real vehicle for ride legs. */
export type RideMode = TransportMode;

// ---------------------------------------------------------------------------
// Journey -- specification section 14
// ---------------------------------------------------------------------------

export type JourneyModeFilter = "ALL" | TransportMode;
export type JourneyStrategy = "MIN_TIME" | "MIN_INTERCHANGE";

export interface JourneyRequest {
  source: string;
  destination: string;
  mode?: JourneyModeFilter;
  strategy?: JourneyStrategy;
  /**
   * Optional ISO-8601 local time. When supplied and `timetableAware` is on,
   * the planner reports real scheduled departures where the source data has
   * them, and clearly marks anything that is an estimate.
   */
  departureTime?: string;
  /** Default true. Set false to force purely static estimates. */
  timetableAware?: boolean;
}

/**
 * A journey leg.
 *
 * `WALK`     moving between two different stops (a real transfer edge).
 * `TRANSFER` changing vehicle at the same stop. Distinct from WALK because no
 *            walking between distinct places is implied, only the changeover.
 */
export type JourneySegmentMode = TransportMode | "WALK" | "TRANSFER";

/**
 * How trustworthy a segment's timing is.
 * - EXACT     both times come from a timetable row in the database.
 * - SCALED    the trip's real duration is distributed across the segment.
 * - ESTIMATED derived from route-level timetable averages / configured speeds.
 *
 * For Metro, EXACT means the timetable printed both the boarding departure and
 * the alighting arrival for that specific run. The source prints one arrival per
 * run, at its terminus, so a journey that gets off part-way along is always
 * SCALED even though its boarding time is exact.
 */
export type TimingConfidence = "EXACT" | "SCALED" | "ESTIMATED";

export interface JourneySegment {
  mode: JourneySegmentMode;
  routeNo?: string;
  operator?: string;
  from: string;
  to: string;
  estimatedMinutes?: number;
  distanceKm?: number;
  stops?: string[];
  departureTime?: string;
  arrivalTime?: string;
  /** Present for ride legs, not for WALK legs. */
  fromStopId?: string;
  toStopId?: string;
  /** Internal graph node ids, so a client can re-request the same path. */
  fromNodeId?: string;
  toNodeId?: string;
  timingConfidence: TimingConfidence;
  /** Real trip used for this leg, when a timetable row matched. */
  tripNo?: number;
  directionId?: number;
  /**
   * Metro runs are identified by a text `trip_id` that is NOT unique on its own:
   * the real identity of a run is the triple (line, trip_id, service_day,
   * direction). All four are reported together so a caller can identify the exact
   * run rather than a number that could match several services.
   */
  tripId?: string;
  serviceDay?: string;
  direction?: string;
  /** Wait before boarding, in minutes. Only set when a departureTime was given. */
  waitMinutes?: number;
}

export interface JourneyResponse {
  source: string;
  destination: string;
  totalTimeMinutes: number;
  /**
   * Omitted unless every leg had real coordinates. The bus and metro source
   * data has no coordinates, so this is currently absent by design rather
   * than fabricated.
   */
  totalDistanceKm?: number;
  interchangeCount: number;
  segments: JourneySegment[];
  /** Which modes actually appear in the returned path. */
  modesUsed: TransportMode[];
  strategy: JourneyStrategy;
  /** True when at least one leg's time came from a real timetable row. */
  timetableMatched: boolean;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Envelope -- specification section 23
// ---------------------------------------------------------------------------

export interface ApiErrorBody {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface ApiSuccessBody<T> {
  success: true;
  data: T;
}

export type ApiResponse<T> = ApiSuccessBody<T> | ApiErrorBody;

// ---------------------------------------------------------------------------
// Page envelope used by list endpoints
// ---------------------------------------------------------------------------

export interface PageMeta {
  total: number;
  limit: number;
  offset: number;
  returned: number;
  hasMore: boolean;
}

export interface PagedData<T> {
  items: T[];
  page: PageMeta;
}

/**
 * Common transport model -- specification section 10, plus the graph types
 * from section 11 and the journey types from section 14.
 *
 * Nothing in this file invents data. Fields that the source data set cannot
 * supply (coordinates, distance) are optional and are omitted from responses
 * rather than guessed.
 */

export type TransportMode = "METRO" | "BUS" | "FERRY" | "TRAM";

export const TRANSPORT_MODES: readonly TransportMode[] = ["METRO", "BUS", "FERRY", "TRAM"];

export function isTransportMode(value: string): value is TransportMode {
  return (TRANSPORT_MODES as readonly string[]).includes(value);
}

/**
 * Modes that used to be part of the API and are no longer served.
 *
 * Empty. TRAM used to be listed here on the premise that Kolkata's tram service
 * had been withdrawn, which was incorrect: the tram network is still in
 * operation, and the current route data (TRAM5 Shyambazar<->Esplanade, TRAM25
 * Gariahat<->Esplanade) is OPERATIONAL. TRAM is now a first-class
 * TransportMode, routed from `tram_legs`, with `transport_modes.tram` already
 * enabled.
 *
 * The empty list is kept rather than deleted because callers still branch on it
 * when deciding how to answer a mode the graph cannot serve.
 */
export const RETIRED_TRANSPORT_MODES = [] as const;

export type RetiredTransportMode = (typeof RETIRED_TRANSPORT_MODES)[number];

export function isRetiredTransportMode(value: string): value is RetiredTransportMode {
  return (RETIRED_TRANSPORT_MODES as readonly string[]).includes(value);
}

/**
 * Reasons a mode cannot produce a ride path right now. Surfaced as a precise
 * 501 with the reason rather than an empty list, which would falsely imply the
 * city has no such service.
 */
export const MODE_UNAVAILABLE_NOTES = {
  FERRY:
    "Ferry routing is unavailable because the ferry data set could not be loaded. " +
    "BUS, METRO and TRAM routing are unaffected.",
  TRAM:
    "Tram routing is unavailable because the tram data set could not be loaded. " +
    "BUS, METRO and FERRY routing are unaffected.",
} as const;

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
// Metro-only planning
//
// The generic JourneyResponse above answers "how do I get there". These types
// answer the question a Metro passenger actually asks, which is a different one:
// which line, in which direction, and where exactly do I change. The generic
// response encodes a change of line as an undifferentiated TRANSFER leg, so the
// line being left and the line being joined are only inferable by comparing
// neighbouring segments. These types state them.
// ---------------------------------------------------------------------------

/**
 * Platform reporting.
 *
 * The supplied Metro data records lines, stations and station codes, and no
 * platform numbers. Rather than invent a platform, this reports `known: false`
 * with the reason, so a client can tell the passenger what to actually look for
 * -- the line colour and the destination signage on the platform.
 */
export interface MetroPlatformInfo {
  known: boolean;
  fromPlatform?: string;
  toPlatform?: string;
  note: string;
}

export interface MetroInterchange {
  /** Station where the change happens. */
  station: string;
  stationCode: string | null;
  /** Every line serving this station, not only the two involved. */
  linesAtStation: string[];
  /** Line the passenger is leaving. */
  fromLine: string;
  /** Line the passenger is joining. */
  toLine: string;
  /**
   * Terminus each train is heading toward. This is real, derived data: it is the
   * end of the line on the far side of the interchange from the direction of
   * travel, taken from the line's own station order. It is what a passenger uses
   * to pick the right platform when no platform numbers exist.
   */
  fromDirection: string | null;
  toDirection: string | null;
  /** Boarding and alighting clock times, when the timetable supplied them. */
  fromArrivalTime?: string;
  toDepartureTime?: string;
  /** Static planning allowance for the change, never a measurement. */
  interchangeMinutes: number;
  platforms: MetroPlatformInfo;
  /** Ready-to-display instruction. */
  instruction: string;
}

export interface MetroJourneyResponse {
  source: string;
  destination: string;
  totalTimeMinutes: number;
  interchangeCount: number;
  /** Metro lines used, in travel order and without repeats. */
  linesUsed: string[];
  /** Intermediate stations passed, excluding the two endpoints. */
  stationsPassed: number;
  segments: JourneySegment[];
  interchanges: MetroInterchange[];
  strategy: JourneyStrategy;
  timetableMatched: boolean;
  /**
   * Set when no Metro-only route exists. Names the lines serving each end and
   * why they cannot meet, instead of reporting a bare "no route found".
   */
  unreachable?: MetroUnreachable;
  warnings: string[];
}

export interface MetroUnreachable {
  sourceLines: string[];
  destinationLines: string[];
  /** Lines that have no shared station with any other line in the source data. */
  isolatedLines: string[];
  reason: string;
}

export interface MetroNetworkLine {
  line: string;
  name: string | null;
  stationCount: number;
  firstStop: string | null;
  lastStop: string | null;
  stationsWithCode: number;
  hasTimetable: boolean;
  /** False when the line shares no station with any other line. */
  connected: boolean;
  /** Index of the connected group this line belongs to. */
  component: number;
}

export interface MetroNetworkInterchange {
  station: string;
  stationCode: string | null;
  lines: string[];
}

export interface MetroNetworkResponse {
  lines: MetroNetworkLine[];
  interchanges: MetroNetworkInterchange[];
  connectivity: {
    /** True only when every line can reach every other line. */
    allLinesConnected: boolean;
    componentCount: number;
    /** Lines with no shared station, which therefore need a surface connection. */
    isolatedLines: string[];
    components: { id: number; lines: string[] }[];
    note: string;
  };
  platformData: {
    available: boolean;
    note: string;
  };
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

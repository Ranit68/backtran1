/**
 * Common transport model -- specification section 10, plus the graph types
 * from section 11 and the journey types from section 14.
 *
 * Nothing in this file invents data. Fields that the source data set cannot
 * supply (coordinates, distance) are optional and are omitted from responses
 * rather than guessed.
 */

export type TransportMode = "METRO" | "BUS" | "TRAM" | "FERRY";

export const TRANSPORT_MODES: readonly TransportMode[] = ["METRO", "BUS", "TRAM", "FERRY"];

export function isTransportMode(value: string): value is TransportMode {
  return (TRANSPORT_MODES as readonly string[]).includes(value);
}

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
  /** Wait before boarding, in minutes. Only set when a departureTime was given. */
  waitMinutes?: number;
}

export interface JourneyResponse {
  source: string;
  destination: string;
  totalTimeMinutes: number;
  /**
   * Omitted unless every leg had real coordinates. The bus and tram source
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

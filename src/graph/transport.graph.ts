import { getAllBusStops, getAllRouteTripStats } from "../repositories/bus.repository.js";
import {
  getAllMetroStations,
  getMetroHopStats,
  METRO_OPERATOR,
} from "../repositories/metro.repository.js";
import { getAllFerryLegs, getAllFerryRoutes, isFerryRouteRoutable } from "../repositories/ferry.repository.js";
import { getAllTramLegs, getAllTramRoutes, getAllTramStops, isTramRouteRoutable } from "../repositories/tram.repository.js";
import type { BusRouteStopRow, RouteTripStatsRow } from "../models/bus.model.js";
import type { MetroHopStatsRow } from "../models/metro.model.js";
import type { FerryLegRow, FerryRouteRow } from "../models/ferry.model.js";
import type { TramLegRow, TramRouteRow, TramStopRow } from "../models/tram.model.js";
import type { GraphEdge, GraphNode, TransportMode } from "../types/transport.js";
import { buildRouteNodeId, buildStopNodeId, normalizeStopName } from "../utils/normalize.js";
import { createRideEdges, createTransferEdge, isTransferEdge } from "./graph.edge.js";
import { createStopNode, isPlaceholderStop } from "./graph.node.js";
import { TransferService, type TransferCandidate } from "../services/transfer.service.js";

/**
 * The unified multi-modal transport graph -- specification section 11.
 *
 * Built once from the database, cached in the process, and rebuilt only on
 * demand (POST /api/admin/graph/refresh) or when the cache goes stale. This is
 * the explicit requirement in spec section 25.
 *
 * A pure data structure: it knows nothing about HTTP, which is what keeps the
 * journey planner portable to a dedicated compute service later (section 28).
 */

export interface RouteInfo {
  routeId: string;
  routeNo: string;
  mode: TransportMode;
  operator: string;
  /** Ordered stop node ids along the route. */
  stopNodeIds: string[];
  stopNames: string[];
  /** Number of hops (stopCount - 1). */
  totalHops: number;
  /** Minutes for one hop, from real timetable averages or the mode default. */
  minutesPerHop: number;
  /**
   * How minutesPerHop was obtained:
   * - TIMETABLE_AVERAGE  real arrival/departure data from a timetable table
   * - LEG_ESTIMATE       the leg's own estimated_minutes (Ferry)
   * - MODE_DEFAULT       median hop time of other routes in the same mode
   * - STATIC_FALLBACK    configured constant, no timing data anywhere
   */
  timeSource: "TIMETABLE_AVERAGE" | "LEG_ESTIMATE" | "MODE_DEFAULT" | "STATIC_FALLBACK";
  /** Real observed end-to-end trip duration, when the timetable supplies it. */
  averageTripMinutes: number | null;
}

export interface GraphStats {
  nodeCount: number;
  edgeCount: number;
  rideEdgeCount: number;
  transferEdgeCount: number;
  routeCount: number;
  busRouteCount: number;
  metroLineCount: number;
  /** Ferry routes that entered the graph, and how many the data set holds. */
  ferryRouteCount: number;
  ferryRoutesExcludedNotOperational: number;
  /** Tram routes that entered the graph, and how many the data set holds. */
  tramRouteCount: number;
  tramRoutesExcludedNotOperational: number;
  /**
   * Leg rows naming a route that has no row in the route table. Non-empty means
   * the two source files disagree, which is a real coverage caveat.
   */
  orphanLegRouteIds: string[];
  /** Lines with no supplied timetable, riding on a static per-hop estimate. */
  metroLinesWithoutTimetable: string[];
  nodesByMode: Record<string, number>;
  routesWithRealTimings: number;
  routesOnStaticEstimate: number;
  /** Routes timed from each leg's own estimated_minutes (Ferry). */
  routesOnLegEstimates: number;
  /**
   * "routeStopOperator:routeNo -> timetableOperator" for every route whose real
   * duration was adopted across an operator boundary, because the route-stop and
   * timetable files disagree about who operates it.
   */
  crossOperatorTimings: string[];
  placeholderStopsExcluded: number;
  transferDetection: ReturnType<TransferService["detect"]>["stats"];
  transferReasons: Record<string, number>;
  buildDurationMs: number;
  builtAt: string;
}

export interface TransportGraphData {
  nodes: Map<string, GraphNode>;
  adjacency: Map<string, GraphEdge[]>;
  routes: Map<string, RouteInfo>;
  /** Every node grouped by its normalised stop name, for source/destination lookup. */
  byStopName: Map<string, GraphNode[]>;
  /** Graph nodes created from source rows that were placeholder stop names. */
  excludedStops: { name: string; mode: TransportMode; operator: string }[];
  transfers: TransferCandidate[];
  stats: GraphStats;
}

/**
 * Fallback hop times, used only when NO route in a mode has timetable data.
 * These are the "static estimated travel times" the specification permits in
 * section 22. They are per hop (one stop to the next), not per route.
 */
const STATIC_FALLBACK_HOP_MINUTES: Record<TransportMode, number> = {
  BUS: 3,
  METRO: 3,
  FERRY: 10,
  // Only reached when a tram route supplies no timing at all. Current tram
  // services are irregular, so this is a rough planning allowance rather than
  // a published headway, and it is reported as STATIC_FALLBACK in the stats.
  TRAM: 5,
};

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    const lower = sorted[middle - 1]!;
    const upper = sorted[middle]!;
    return (lower + upper) / 2;
  }
  return sorted[middle]!;
}

export class TransportGraph {
  readonly data: TransportGraphData;

  constructor(data: TransportGraphData) {
    this.data = data;
  }

  get nodeCount(): number {
    return this.data.nodes.size;
  }

  getNode(id: string): GraphNode | undefined {
    return this.data.nodes.get(id);
  }

  get edges(): GraphEdge[] {
    const all: GraphEdge[] = [];
    for (const edges of this.data.adjacency.values()) all.push(...edges);
    return all;
  }

  neighbours(nodeId: string): GraphEdge[] {
    return this.data.adjacency.get(nodeId) ?? [];
  }

  /** Nodes whose normalised name matches exactly. */
  findNodesByName(normalizedName: string): GraphNode[] {
    return this.data.byStopName.get(normalizedName) ?? [];
  }

  /**
   * Resolves a user-supplied place name to graph nodes.
   *
   * Exact normalised matches win. When there are none, a fuzzy fallback returns
   * the closest nodes above a threshold so that "gariahat" still finds
   * "Gariahat Depot (In Gate)". `minScore` lets the caller be strict.
   */
  resolvePlace(
    name: string,
    options: { minScore?: number; limit?: number } = {},
  ): { node: GraphNode; score: number }[] {
    const normalized = normalizeStopName(name);
    if (normalized.length === 0) return [];

    const exact = this.findNodesByName(normalized);
    if (exact.length > 0) {
      return exact.slice(0, options.limit ?? 25).map((node) => ({ node, score: 1 }));
    }

    const scored: { node: GraphNode; score: number }[] = [];
    const seen = new Set<string>();
    for (const [, nodes] of this.data.byStopName) {
      for (const node of nodes) {
        if (seen.has(node.id)) continue;
        seen.add(node.id);
        // Containment is the useful signal here: "Gariahat" should match
        // "Gariahat Depot (In Gate)".
        const candidateName = normalizeStopName(node.name);
        let score = 0;
        if (candidateName.includes(normalized) || normalized.includes(candidateName)) {
          score = 0.9;
        } else {
          const distance = levenshtein(candidateName, normalized);
          const longest = Math.max(candidateName.length, normalized.length, 1);
          score = 1 - distance / longest;
        }
        if (score >= (options.minScore ?? 0.75)) scored.push({ node, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, options.limit ?? 25);
  }

  toJSON(): GraphStats {
    return this.data.stats;
  }
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  let current = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost);
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[b.length] ?? 0;
}

// ---------------------------------------------------------------------------
// Optional providers: Ferry and Tram
// ---------------------------------------------------------------------------

/** A provider's contribution plus the data problems worth reporting. */
interface ProviderResult {
  seeds: RouteSeed[];
  routes: number;
  /** Route ids present in a leg table with no matching route row. */
  orphanRouteIds: string[];
  /** Rows kept out of the graph because their route is not OPERATIONAL. */
  excludedNonRoutable: number;
}

/**
 * Ferry graph provider.
 *
 * Edges come from `ferry_legs` and nowhere else -- not from a pairwise expansion
 * of a route's ghat list, and not from the ghat master. A route is included only
 * when its status is OPERATIONAL; a suspended or cancelled route is counted and
 * reported, not deleted and not routed.
 *
 * Each leg already records one travel direction, so edges stay one-way exactly
 * as supplied.
 */
async function loadFerryProvider(): Promise<ProviderResult> {
  const empty: ProviderResult = {
    seeds: [],
    routes: 0,
    orphanRouteIds: [],
    excludedNonRoutable: 0,
  };

  const [routes, legs] = await Promise.all([
    getAllFerryRoutes().catch(() => [] as FerryRouteRow[]),
    getAllFerryLegs().catch(() => [] as FerryLegRow[]),
  ]);
  if (routes.length === 0) return empty;

  const byId = new Map(routes.map((route) => [route.route_id, route]));

  // A node id is built from the operator, so a route with no operator cannot be
  // keyed without guessing. Ferries are run by several different operators
  // (WBTC, WBTC/HNJPSS and a private operator), so there is no safe default to
  // substitute: such a route is left out rather than given an invented identity.
  const routableRoutes = routes.filter(
    (route) => isFerryRouteRoutable(route.status) && Boolean(route.operator),
  );
  const routable = new Set(routableRoutes.map((route) => route.route_id));
  // Counted per route, not per leg, to match the reported stat.
  const excludedNonRoutable = routes.length - routableRoutes.length;

  // Legs are grouped by route and ordered so the graph is deterministic: the
  // source rows carry no segment sequence for ferry, so endpoints and id order
  // stand in for one.
  const legsByRoute = new Map<string, FerryLegRow[]>();
  const orphanRouteIds = new Set<string>();
  for (const leg of legs) {
    if (!byId.has(leg.route_id)) {
      orphanRouteIds.add(leg.route_id);
      continue;
    }
    if (!routable.has(leg.route_id)) continue;
    const bucket = legsByRoute.get(leg.route_id);
    if (bucket) bucket.push(leg);
    else legsByRoute.set(leg.route_id, [leg]);
  }

  const seeds: RouteSeed[] = [];
  for (const route of routableRoutes) {
    const routeLegs = legsByRoute.get(route.route_id) ?? [];
    if (routeLegs.length === 0) continue;

    const hops = routeLegs.map((leg) => ({
      fromStop: leg.from_ghat,
      toStop: leg.to_ghat,
      minutes: leg.estimated_minutes !== null && leg.estimated_minutes > 0
        ? leg.estimated_minutes
        : null,
    }));

    // A leg's own estimated_minutes is a real per-edge duration, so the route
    // averages to a representative hop time. Where no leg carries one, it falls
    // through to the mode's static allowance below.
    const timed = hops.map((h) => h.minutes).filter((m): m is number => m !== null);
    const seed: RouteSeed = {
      routeNo: route.route_id,
      operator: route.operator!,
      mode: "FERRY",
      stopNames: [],
      hops,
      averageTripMinutes: null,
    };
    if (timed.length > 0) {
      seed.minutesPerHop = timed.reduce((a, b) => a + b, 0) / timed.length;
    }
    seeds.push(seed);
  }

  return {
    seeds,
    routes: routes.length,
    orphanRouteIds: [...orphanRouteIds],
    excludedNonRoutable,
  };
}

/**
 * Tram graph provider.
 *
 * Built from `tram_legs`, which already carries an explicit FORWARD and REVERSE
 * row for every segment, so the graph holds exactly the recorded directed edges
 * and nothing is reversed or reconstructed from stop names.
 *
 * Only OPERATIONAL regular routes are included. `tram_heritage_services` and
 * `tram_excluded_historical_routes` are deliberately not read here: heritage
 * trams are special services a passenger cannot plan around, and historical
 * routes are kept out of the live graph on purpose.
 *
 * No leg carries a duration and both live routes are IRREGULAR with no published
 * headway, so every tram leg is an estimate on the static per-hop allowance. It
 * is reported as STATIC_FALLBACK rather than dressed up as a timetable.
 */
async function loadTramProvider(): Promise<ProviderResult> {
  const empty: ProviderResult = {
    seeds: [],
    routes: 0,
    orphanRouteIds: [],
    excludedNonRoutable: 0,
  };

  const [routes, legs, stops] = await Promise.all([
    getAllTramRoutes().catch(() => [] as TramRouteRow[]),
    getAllTramLegs().catch(() => [] as TramLegRow[]),
    getAllTramStops().catch(() => [] as TramStopRow[]),
  ]);
  if (routes.length === 0) return empty;

  const byId = new Map(routes.map((route) => [route.route_id, route]));

  // A node id is built from the operator, so a route with none cannot be keyed
  // without guessing; it is left out rather than given an invented identity.
  const routableRoutes = routes.filter(
    (route) => isTramRouteRoutable(route.status) && Boolean(route.operator),
  );
  const routable = new Set(routableRoutes.map((route) => route.route_id));
  // Counted per route, not per leg, to match the reported stat.
  const excludedNonRoutable = routes.length - routableRoutes.length;

  // The stop sequence is the supplied stop_sequence order, never alphabetical.
  // Both travel directions traverse this same sequence, so it is stored once per
  // route and shared by the FORWARD and REVERSE legs.
  const stopsByRoute = new Map<string, TramStopRow[]>();
  for (const stop of stops) {
    if (!routable.has(stop.route_id)) continue;
    const bucket = stopsByRoute.get(stop.route_id);
    if (bucket) bucket.push(stop);
    else stopsByRoute.set(stop.route_id, [stop]);
  }
  for (const bucket of stopsByRoute.values()) {
    bucket.sort((a, b) => {
      const seqA = a.stop_sequence ?? Number.MAX_SAFE_INTEGER;
      const seqB = b.stop_sequence ?? Number.MAX_SAFE_INTEGER;
      if (seqA !== seqB) return seqA - seqB;
      return a.stop_id.localeCompare(b.stop_id);
    });
  }

  const legsByRoute = new Map<string, TramLegRow[]>();
  const orphanRouteIds = new Set<string>();
  for (const leg of legs) {
    if (!byId.has(leg.route_id)) {
      orphanRouteIds.add(leg.route_id);
      continue;
    }
    if (!routable.has(leg.route_id)) continue;
    const bucket = legsByRoute.get(leg.route_id);
    if (bucket) bucket.push(leg);
    else legsByRoute.set(leg.route_id, [leg]);
  }

  const seeds: RouteSeed[] = [];
  for (const route of routableRoutes) {
    const routeLegs = legsByRoute.get(route.route_id) ?? [];
    if (routeLegs.length === 0) continue;

    // Ordered by segment_sequence then direction, so FORWARD and REVERSE of the
    // same segment stay adjacent and the build is deterministic.
    routeLegs.sort((a, b) => {
      const seqA = a.segment_sequence ?? Number.MAX_SAFE_INTEGER;
      const seqB = b.segment_sequence ?? Number.MAX_SAFE_INTEGER;
      if (seqA !== seqB) return seqA - seqB;
      return (a.direction ?? "").localeCompare(b.direction ?? "");
    });

    seeds.push({
      routeNo: route.route_no ?? route.route_id,
      operator: route.operator!,
      mode: "TRAM",
      stopNames: (stopsByRoute.get(route.route_id) ?? []).map((stop) => stop.stop_name),
      hops: routeLegs.map((leg) => ({
        fromStop: leg.from_stop,
        toStop: leg.to_stop,
        minutes: null,
        direction: leg.direction ?? null,
      })),
      averageTripMinutes: null,
    });
  }

  return {
    seeds,
    routes: routes.length,
    orphanRouteIds: [...orphanRouteIds],
    excludedNonRoutable,
  };
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export interface BuildGraphOptions {
  /** Per-mode hop time used only when no real data exists anywhere. */
  staticFallbackHopMinutes?: Partial<Record<TransportMode, number>>;
  transfer?: ConstructorParameters<typeof TransferService>[0];
}

interface RouteSeed {
  routeNo: string;
  operator: string;
  mode: TransportMode;
  /**
   * Linear stop order. Used by Bus and Metro, whose source is a single ordered
   * stop list per route.
   *
   * Empty for Ferry and Tram, which are built from explicit directed legs
   * instead -- see `hops`.
   */
  stopNames: string[];
  /**
   * Explicit directed legs, in the order the source records them.
   *
   * `minutes` is the leg's own `estimated_minutes` when the source supplies one
   * (Ferry) and null when it does not (Tram), in which case the route falls back
   * to the mode's static planning allowance. Every hop is already
   * direction-specific, so no reverse is synthesised.
   *
   * `direction` groups the legs of one travel direction so hop numbers are
   * counted per direction: a tram route's 60 leg rows are 30 hops forward and 30
   * back, and "hop 12 of 30" is only true within one of them. It is null for a
   * source that does not distinguish directions.
   */
  hops?: {
    fromStop: string;
    toStop: string;
    minutes: number | null;
    direction?: string | null;
  }[];
  averageTripMinutes: number | null;
  /**
   * Real minutes per hop, when the source supplies per-station times.
   *
   * For Metro this is measured between consecutive printed times inside a run
   * rather than derived from an average trip duration, because the Metro source
   * mixes full-length runs with short-turns.
   */
  minutesPerHop?: number;
}

/**
 * Matches a route's real trip duration against the rows in route_trip_stats.
 *
 * The two source files disagree about who operates a route: the route-stop file
 * has no operator column and its rows are written as WBTC, while the timetable
 * file carries its own operator (CSTC). An exact (operator, route_no) lookup
 * therefore never matches anything, and every route silently fell back to a
 * static estimate even though real durations were present.
 *
 * Two tiers, in order of confidence:
 *   1. exact (operator, route_no) - the two files agree about the operator.
 *   2. route_no alone, accepted only when exactly one operator claims that
 *      number, so two operators' durations are never averaged together.
 *
 * Tier 2 is a deliberate compromise, so it is recorded in `crossOperatorMatches`
 * and surfaced in the graph stats instead of being applied quietly.
 */
export function createRouteStatsLookup(stats: RouteTripStatsRow[]): {
  match: (operator: string, routeNo: string) => RouteTripStatsRow | null;
  crossOperatorMatches: string[];
} {
  const byOperatorAndRoute = new Map<string, RouteTripStatsRow>();
  const byRouteNo = new Map<string, RouteTripStatsRow[]>();
  for (const stat of stats) {
    byOperatorAndRoute.set(`${stat.operator}|${stat.route_no}`, stat);
    const bucket = byRouteNo.get(stat.route_no);
    if (bucket) bucket.push(stat);
    else byRouteNo.set(stat.route_no, [stat]);
  }

  const crossOperatorMatches: string[] = [];

  const match = (operator: string, routeNo: string): RouteTripStatsRow | null => {
    const exact = byOperatorAndRoute.get(`${operator}|${routeNo}`);
    if (exact) return exact;

    const candidates = byRouteNo.get(routeNo) ?? [];
    if (candidates.length !== 1) return null;

    const only = candidates[0]!;
    if (only.avg_trip_minutes === null || only.avg_trip_minutes <= 0) return null;

    crossOperatorMatches.push(`${operator}:${routeNo} -> ${only.operator}`);
    return only;
  };

  return { match, crossOperatorMatches };
}

/**
 * Loads all transport data and assembles the graph.
 *
 * Ride-time sourcing, in priority order:
 *  1. The route's own real average trip duration from bus_timetables, divided
 *     by its hop count. Derived from actual arrival/departure values.
 *  2. The median hop time across all routes in the same mode that do have real
 *     durations. Still derived from real data, just borrowed between routes.
 *  3. A configured static constant. Only reached when the entire mode has no
 *     timetable data at all -- the case the specification explicitly allows.
 */
export async function buildTransportGraph(options: BuildGraphOptions = {}): Promise<TransportGraph> {
  const startedAt = Date.now();

  const [busStops, metroStations, routeStats, metroHopStats] = await Promise.all([
    getAllBusStops(),
    getAllMetroStations(),
    getAllRouteTripStats("BUS").catch(() => [] as RouteTripStatsRow[]),
    // A failure here must not cost the bus graph, so Metro falls back to its
    // static hop time rather than failing the whole build.
    getMetroHopStats().catch(() => [] as MetroHopStatsRow[]),
  ]);

  // Ferry and Tram are optional providers. Each load is isolated so that one
  // failing data set degrades only its own mode: bus, metro and the other
  // optional mode must keep serving. An empty list simply contributes no seeds.
  const [ferry, tram] = await Promise.all([loadFerryProvider(), loadTramProvider()]);

  const hopByLine = new Map(metroHopStats.map((row) => [row.line, row.avg_minutes_per_hop]));
  const nodes = new Map<string, GraphNode>();
  const byStopName = new Map<string, GraphNode[]>();
  const excludedStops: { name: string; mode: TransportMode; operator: string }[] = [];
  const routes = new Map<string, RouteInfo>();
  const adjacency = new Map<string, GraphEdge[]>();

  const { match: findStatsFor, crossOperatorMatches: crossOperatorTimings } = createRouteStatsLookup(routeStats);

  // ---- group source rows into ordered routes -------------------------------
  const busSeeds = new Map<string, RouteSeed>();
  for (const row of busStops) {
    const key = `${row.operator}|${row.route_no}`;
    const seed = busSeeds.get(key);
    if (seed) {
      seed.stopNames.push(row.stop_name);
    } else {
      busSeeds.set(key, {
        routeNo: row.route_no,
        operator: row.operator,
        mode: "BUS",
        stopNames: [row.stop_name],
        averageTripMinutes: null,
      });
    }
  }

  // Metro "routes" are lines. `metro_stations.station_sequence` is the supplied
  // 1-based line order and is contiguous, so grouping by line and trusting that
  // order needs no reversal guesswork.
  const metroSeeds = new Map<string, RouteSeed>();
  for (const row of metroStations) {
    const seed = metroSeeds.get(row.line);
    if (seed) {
      seed.stopNames.push(row.station_name);
    } else {
      metroSeeds.set(row.line, {
        routeNo: row.line,
        operator: METRO_OPERATOR,
        mode: "METRO",
        stopNames: [row.station_name],
        averageTripMinutes: null,
        minutesPerHop: hopByLine.get(row.line),
      });
    }
  }

  for (const seed of busSeeds.values()) {
    const stat = findStatsFor(seed.operator, seed.routeNo);
    if (stat) seed.averageTripMinutes = stat.avg_trip_minutes;
  }

  const allSeeds = [
    ...busSeeds.values(),
    ...metroSeeds.values(),
    ...ferry.seeds,
    ...tram.seeds,
  ];

  // ---- derive per-hop minutes ----------------------------------------------
  // Only Bus and Metro have a real end-to-end trip duration to divide, and only
  // they can lend one to a sibling route. Ferry and Tram are per-leg instead, so
  // they are excluded here rather than being given a borrowed average.
  const hopMinutesByMode = new Map<TransportMode, number | null>();
  for (const mode of ["BUS", "METRO"] as TransportMode[]) {
    const samples: number[] = [];
    for (const seed of allSeeds) {
      if (seed.mode !== mode) continue;
      if (seed.averageTripMinutes === null || seed.averageTripMinutes <= 0) continue;
      const hops = seed.hops ? seed.hops.length : seed.stopNames.length - 1;
      if (hops <= 0) continue;
      samples.push(seed.averageTripMinutes / hops);
    }
    hopMinutesByMode.set(mode, median(samples));
  }

  // ---- create nodes and ride edges -----------------------------------------
  let rideEdgeCount = 0;
  let routesWithRealTimings = 0;
  let routesOnStaticEstimate = 0;
  let routesOnLegEstimates = 0;
  let placeholderStopsExcluded = 0;

  const addEdge = (edge: GraphEdge): void => {
    const bucket = adjacency.get(edge.fromNodeId);
    if (bucket) {
      bucket.push(edge);
    } else {
      adjacency.set(edge.fromNodeId, [edge]);
    }
  };

  /**
   * Creates and registers the graph node for a stop name, returning its id.
   * A node is one (mode, operator, normalised name) triple, so two routes
   * calling at the same place share it and the interchange is free.
   */
  const ensureNode = (stopName: string, mode: TransportMode, operator: string): string | null => {
    if (isPlaceholderStop(stopName)) {
      // Kept in the database, excluded here. See graph.node.ts.
      placeholderStopsExcluded += 1;
      excludedStops.push({ name: stopName, mode, operator });
      return null;
    }
    const node = createStopNode({ name: stopName, mode, operator });
    if (!nodes.has(node.id)) {
      nodes.set(node.id, node);
      const key = normalizeStopName(node.name);
      const bucket = byStopName.get(key);
      if (bucket) bucket.push(node);
      else byStopName.set(key, [node]);
    }
    return node.id;
  };

  for (const seed of allSeeds) {
    const routeId = buildRouteNodeId(seed.mode, seed.operator, seed.routeNo);
    const stopNodeIds: string[] = [];
    const usableStopNames: string[] = [];

    const isLegBased = seed.hops !== undefined && seed.hops.length > 0;

    /**
     * The stops a leg-based route visits, in hop order, with consecutive
     * repeats collapsed. Only used when the seed carries no sequence of its own
     * (Ferry). A loop route (F005 returns to its first ghat) is therefore listed
     * once at the front and once at the end, which is correct: it really does
     * call at both ends of its own sequence.
     */
    const orderedStopNames: string[] = [];
    if (seed.stopNames.length > 0) {
      // Tram supplies its own stop order via tram_stops.stop_sequence, which is
      // the authoritative sequence. Deriving it from the legs instead would
      // interleave the FORWARD and REVERSE rows of each segment.
      orderedStopNames.push(...seed.stopNames);
    } else if (isLegBased) {
      for (const hop of seed.hops!) {
        if (orderedStopNames[orderedStopNames.length - 1] !== hop.fromStop) {
          orderedStopNames.push(hop.fromStop);
        }
        if (orderedStopNames[orderedStopNames.length - 1] !== hop.toStop) {
          orderedStopNames.push(hop.toStop);
        }
      }
    }

    for (const stopName of orderedStopNames) {
      const nodeId = ensureNode(stopName, seed.mode, seed.operator);
      if (nodeId === null) continue;
      stopNodeIds.push(nodeId);
      usableStopNames.push(stopName);
    }

    /**
     * Hop numbering for a leg-based route, counted within each travel direction.
     *
     * Counting over the flat leg list would number a tram's 60 rows 0..59, so the
     * last forward hop would report "of 60" when a single traversal is 30 hops.
     * Directions with differing counts (or no direction at all, as with ferry)
     * fall back to numbering over the whole list, which is then the true hop
     * count of the route as recorded.
     */
    const hopsPerDirection = new Map<string, number>();
    if (isLegBased) {
      for (const hop of seed.hops!) {
        const key = hop.direction ?? "";
        hopsPerDirection.set(key, (hopsPerDirection.get(key) ?? 0) + 1);
      }
    }
    const directionTotals = [...hopsPerDirection.values()];
    const countPerDirection = directionTotals.length > 1 && directionTotals.every((n) => n === directionTotals[0]);
    const hopIndexCursor = new Map<string, number>();
    /** Falls back to the flat position when the route is not numbered per direction. */
    const legs = seed.hops ?? [];
    const hopIndexOf = (hop: { direction?: string | null }, fallback: number): number => {
      if (!countPerDirection) return fallback;
      const key = hop.direction ?? "";
      const at = hopIndexCursor.get(key) ?? 0;
      hopIndexCursor.set(key, at + 1);
      return at;
    };
    /** Hops in one traversal of this route. */
    const totalHopsPerDirection = countPerDirection ? (directionTotals[0] ?? legs.length) : legs.length;
    const hopTotalFor = (): number => totalHopsPerDirection;

    const totalHops = isLegBased ? totalHopsPerDirection : stopNodeIds.length - 1;
    if (totalHops <= 0) {
      // Single-stop or fully-placeholder route: nothing to ride.
      continue;
    }

    let minutesPerHop: number;
    let timeSource: RouteInfo["timeSource"];
    /** Per-hop overrides, present only when a leg carries its own duration. */
    const hopMinutes: (number | null)[] =
      isLegBased ? seed.hops!.map((hop) => hop.minutes) : [];

    if (isLegBased && hopMinutes.some((m) => m !== null)) {
      // Ferry: the leg's own estimated_minutes is a real per-edge duration, so
      // the route's representative hop time is their mean. It is still an
      // estimate, not a printed schedule, hence LEG_ESTIMATE.
      const timed = hopMinutes.filter((m): m is number => m !== null);
      minutesPerHop = timed.reduce((a, b) => a + b, 0) / timed.length;
      timeSource = "LEG_ESTIMATE";
      routesOnLegEstimates += 1;
    } else if (seed.minutesPerHop !== undefined && seed.minutesPerHop > 0) {
      // Metro: measured directly between consecutive printed times.
      minutesPerHop = seed.minutesPerHop;
      timeSource = "TIMETABLE_AVERAGE";
      routesWithRealTimings += 1;
    } else if (seed.averageTripMinutes !== null && seed.averageTripMinutes > 0) {
      minutesPerHop = seed.averageTripMinutes / totalHops;
      timeSource = "TIMETABLE_AVERAGE";
      routesWithRealTimings += 1;
    } else {
      const modeDefault = hopMinutesByMode.get(seed.mode);
      if (modeDefault !== null && modeDefault !== undefined && modeDefault > 0) {
        minutesPerHop = modeDefault;
        timeSource = "MODE_DEFAULT";
      } else {
        minutesPerHop =
          options.staticFallbackHopMinutes?.[seed.mode] ?? STATIC_FALLBACK_HOP_MINUTES[seed.mode];
        timeSource = "STATIC_FALLBACK";
      }
      routesOnStaticEstimate += 1;
    }
    minutesPerHop = Math.max(0.5, Math.round(minutesPerHop * 100) / 100);

    // Every recorded leg is emitted, not just one direction's worth.
    const hopCount = isLegBased ? seed.hops!.length : Math.max(0, stopNodeIds.length - 1);
    for (let hop = 0; hop < hopCount; hop += 1) {
      let fromNodeId: string;
      let toNodeId: string;
      let hopMinutesValue: number;
      let fromHop: number;
      let hopsInDirection: number;

      if (isLegBased) {
        const leg = seed.hops![hop]!;
        const from = ensureNode(leg.fromStop, seed.mode, seed.operator);
        const to = ensureNode(leg.toStop, seed.mode, seed.operator);
        if (from === null || to === null) continue;
        fromNodeId = from;
        toNodeId = to;
        // A leg with no duration of its own rides on the route's representative
        // hop time, which for Tram is the static allowance.
        hopMinutesValue = leg.minutes ?? minutesPerHop;
        fromHop = hopIndexOf(leg, hop);
        hopsInDirection = hopTotalFor();
      } else {
        fromNodeId = stopNodeIds[hop]!;
        toNodeId = stopNodeIds[hop + 1]!;
        hopMinutesValue = minutesPerHop;
        fromHop = hop;
        hopsInDirection = hopCount;
      }

      // A route that visits the same stop twice in its own sequence (a loop
      // route) would otherwise create a self-loop; skip those hops.
      if (fromNodeId === toNodeId) continue;
      const edges = createRideEdges({
        fromNodeId,
        toNodeId,
        mode: seed.mode,
        routeId,
        routeNo: seed.routeNo,
        operator: seed.operator,
        estimatedTimeMinutes: hopMinutesValue,
        fromHop,
        toHop: fromHop + 1,
        totalHops: hopsInDirection,
        // Ferry and Tram legs already record one direction each, so the reverse
        // must not be manufactured from them.
        bidirectional: !isLegBased,
      });
      for (const edge of edges) {
        addEdge(edge);
        rideEdgeCount += 1;
      }
    }

    routes.set(routeId, {
      routeId,
      routeNo: seed.routeNo,
      mode: seed.mode,
      operator: seed.operator,
      stopNodeIds,
      stopNames: usableStopNames,
      totalHops,
      minutesPerHop,
      timeSource,
      averageTripMinutes: seed.averageTripMinutes,
    });
  }

  // ---- transfer edges ------------------------------------------------------
  const transferService = new TransferService(options.transfer);
  const { candidates, stats: transferStats } = transferService.detect([...nodes.values()]);

  const transferReasons: Record<string, number> = {};
  for (const candidate of candidates) {
    transferReasons[candidate.reason] = (transferReasons[candidate.reason] ?? 0) + 1;
    const edge = createTransferEdge({
      fromNodeId: candidate.from.id,
      toNodeId: candidate.to.id,
      transferTimeMinutes: candidate.transferTimeMinutes,
      distanceMeters: candidate.distanceMeters ?? undefined,
      reason: candidate.reason,
      nameSimilarity: candidate.nameSimilarity,
    });
    // Symmetric: you can change in either direction.
    addEdge(edge);
    addEdge({
      ...edge,
      fromNodeId: candidate.to.id,
      toNodeId: candidate.from.id,
    });
  }

  const nodesByMode: Record<string, number> = {};
  for (const node of nodes.values()) {
    nodesByMode[node.mode] = (nodesByMode[node.mode] ?? 0) + 1;
  }

  let transferEdgeCount = 0;
  for (const edges of adjacency.values()) {
    for (const edge of edges) if (isTransferEdge(edge)) transferEdgeCount += 1;
  }

  const stats: GraphStats = {
    nodeCount: nodes.size,
    edgeCount: rideEdgeCount + transferEdgeCount,
    rideEdgeCount,
    transferEdgeCount,
    routeCount: routes.size,
    busRouteCount: busSeeds.size,
    metroLineCount: metroSeeds.size,
    ferryRouteCount: ferry.seeds.length,
    ferryRoutesExcludedNotOperational: ferry.excludedNonRoutable,
    tramRouteCount: tram.seeds.length,
    tramRoutesExcludedNotOperational: tram.excludedNonRoutable,
    orphanLegRouteIds: [...ferry.orphanRouteIds, ...tram.orphanRouteIds],
    metroLinesWithoutTimetable: [...metroSeeds.entries()]
      .filter(([, seed]) => seed.minutesPerHop === undefined)
      .map(([line]) => line),
    nodesByMode,
    routesWithRealTimings,
    routesOnStaticEstimate,
    routesOnLegEstimates,
    // Route numbers whose real durations were adopted from a different
    // operator's timetable. Non-empty means the two source files disagree
    // about who operates the route, which is a real coverage caveat.
    crossOperatorTimings,
    placeholderStopsExcluded,
    transferDetection: transferStats,
    transferReasons,
    buildDurationMs: Date.now() - startedAt,
    builtAt: new Date().toISOString(),
  };

  return new TransportGraph({
    nodes,
    adjacency,
    routes,
    byStopName,
    excludedStops,
    transfers: candidates,
    stats,
  });
}

/**
 * Looks up a route by its public route number. Route numbers are identifiers
 * (spec section 19), so matching is on the normalised form and returns all
 * operators that share a number.
 */
export function findRoutesByNumber(graph: TransportGraph, routeNo: string): RouteInfo[] {
  const target = routeNo.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const matches: RouteInfo[] = [];
  for (const route of graph.data.routes.values()) {
    const key = route.routeNo.toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (key === target) matches.push(route);
  }
  return matches;
}

export type { BusRouteStopRow };
export { buildStopNodeId };

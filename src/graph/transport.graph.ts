import { getAllBusStops, getAllRouteTripStats } from "../repositories/bus.repository.js";
import { getAllTramStops } from "../repositories/tram.repository.js";
import type { BusRouteStopRow, RouteTripStatsRow } from "../models/bus.model.js";
import type { TramRouteStopRow } from "../models/tram.model.js";
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
   * - TIMETABLE_AVERAGE  real arrival/departure data from bus_timetables
   * - MODE_DEFAULT       median hop time of other routes in the same mode
   * - STATIC_FALLBACK    configured constant, no timetable data anywhere
   */
  timeSource: "TIMETABLE_AVERAGE" | "MODE_DEFAULT" | "STATIC_FALLBACK";
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
  tramRouteCount: number;
  nodesByMode: Record<string, number>;
  routesWithRealTimings: number;
  routesOnStaticEstimate: number;
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
  TRAM: 3,
  METRO: 2,
  FERRY: 10,
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
  stopNames: string[];
  averageTripMinutes: number | null;
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

  const [busStops, tramStops, routeStats] = await Promise.all([
    getAllBusStops(),
    getAllTramStops(),
    getAllRouteTripStats("BUS").catch(() => [] as RouteTripStatsRow[]),
  ]);

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

  const tramSeeds = new Map<string, RouteSeed>();
  for (const row of tramStops) {
    const key = `${row.operator}|${row.route_no}`;
    const seed = tramSeeds.get(key);
    if (seed) {
      seed.stopNames.push(row.stop_name);
    } else {
      tramSeeds.set(key, {
        routeNo: row.route_no,
        operator: row.operator,
        mode: "TRAM",
        stopNames: [row.stop_name],
        averageTripMinutes: null,
      });
    }
  }

  for (const seed of busSeeds.values()) {
    const stat = findStatsFor(seed.operator, seed.routeNo);
    if (stat) seed.averageTripMinutes = stat.avg_trip_minutes;
  }

  const allSeeds = [...busSeeds.values(), ...tramSeeds.values()];

  // ---- derive per-hop minutes ----------------------------------------------
  const hopMinutesByMode = new Map<TransportMode, number | null>();
  for (const mode of ["BUS", "TRAM"] as TransportMode[]) {
    const samples: number[] = [];
    for (const seed of allSeeds) {
      if (seed.mode !== mode) continue;
      if (seed.averageTripMinutes === null || seed.averageTripMinutes <= 0) continue;
      const hops = seed.stopNames.length - 1;
      if (hops <= 0) continue;
      samples.push(seed.averageTripMinutes / hops);
    }
    hopMinutesByMode.set(mode, median(samples));
  }

  // ---- create nodes and ride edges -----------------------------------------
  let rideEdgeCount = 0;
  let routesWithRealTimings = 0;
  let routesOnStaticEstimate = 0;
  let placeholderStopsExcluded = 0;

  const addEdge = (edge: GraphEdge): void => {
    const bucket = adjacency.get(edge.fromNodeId);
    if (bucket) {
      bucket.push(edge);
    } else {
      adjacency.set(edge.fromNodeId, [edge]);
    }
  };

  for (const seed of allSeeds) {
    const routeId = buildRouteNodeId(seed.mode, seed.operator, seed.routeNo);
    const stopNodeIds: string[] = [];
    const usableStopNames: string[] = [];

    for (const stopName of seed.stopNames) {
      if (isPlaceholderStop(stopName)) {
        // Kept in the database, excluded here. See graph.node.ts.
        placeholderStopsExcluded += 1;
        excludedStops.push({ name: stopName, mode: seed.mode, operator: seed.operator });
        continue;
      }
      const node = createStopNode({ name: stopName, mode: seed.mode, operator: seed.operator });
      if (!nodes.has(node.id)) {
        nodes.set(node.id, node);
        const key = normalizeStopName(node.name);
        const bucket = byStopName.get(key);
        if (bucket) bucket.push(node);
        else byStopName.set(key, [node]);
      }
      stopNodeIds.push(node.id);
      usableStopNames.push(node.name);
    }

    const totalHops = stopNodeIds.length - 1;
    if (totalHops <= 0) {
      // Single-stop or fully-placeholder route: nothing to ride.
      continue;
    }

    let minutesPerHop: number;
    let timeSource: RouteInfo["timeSource"];
    if (seed.averageTripMinutes !== null && seed.averageTripMinutes > 0) {
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

    for (let hop = 0; hop < totalHops; hop += 1) {
      const fromNodeId = stopNodeIds[hop]!;
      const toNodeId = stopNodeIds[hop + 1]!;
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
        estimatedTimeMinutes: minutesPerHop,
        fromHop: hop,
        toHop: hop + 1,
        totalHops,
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
    tramRouteCount: tramSeeds.size,
    nodesByMode,
    routesWithRealTimings,
    routesOnStaticEstimate,
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

export type { BusRouteStopRow, TramRouteStopRow };
export { buildStopNodeId };

import type { GraphEdge, JourneyStrategy, TransportMode } from "../types/transport.js";
import { edgeTimeMinutes, isTransferEdge } from "./graph.edge.js";
import { haversineDistanceMeters } from "../utils/geo.js";
import type { TransportGraph } from "./transport.graph.js";

/**
 * A* shortest-path search over the unified transport graph.
 *
 * Framework-independent (spec section 28): this module takes a graph and two
 * node ids and returns a path. It knows nothing about HTTP, so it can be moved
 * into a dedicated compute service unchanged if graph work ever outgrows a
 * serverless function.
 */

/**
 * Extra minutes charged for each interchange, used to break ties and to express
 * the MIN_INTERCHANGE strategy.
 *
 * MIN_TIME keeps this small so a faster-but-more-changes journey can still win.
 * MIN_INTERCHANGE makes it large enough to dominate any plausible time
 * difference, which turns the search into a lexicographic "fewest changes,
 * then fastest" optimisation.
 */
const TRANSFER_PENALTY = {
  MIN_TIME: 2,
  MIN_INTERCHANGE: 10_000,
} as const;

export interface PathfindingOptions {
  strategy?: JourneyStrategy;
  /** Restrict the search to these vehicle modes. 'ALL' means no restriction. */
  modes?: "ALL" | TransportMode;
  /** Stop expanding once this many nodes have been settled. */
  maxExpansions?: number;
}

export interface PathStep {
  edge: GraphEdge;
  fromNodeId: string;
  toNodeId: string;
}

export interface PathResult {
  found: boolean;
  steps: PathStep[];
  /** Sum of edge travel times, excluding the strategy's transfer penalty. */
  totalTimeMinutes: number;
  /** Real interchange count: TRANSFER and WALK edges on the path. */
  transfers: number;
  nodesExplored: number;
  /** Populated when found is false, for diagnostics. */
  reason?: "NO_PATH" | "ENDPOINT_UNKNOWN" | "SEARCH_LIMIT";
}

/** Fastest assumed vehicle speed, used only as an A* lower bound. */
const MAX_SPEED_METERS_PER_MINUTE = 30 * 1000 / 60;

function heuristic(graph: TransportGraph, fromId: string, toId: string): number {
  const from = graph.getNode(fromId);
  const to = graph.getNode(toId);
  if (!from || !to) return 0;
  if (
    typeof from.latitude !== "number" ||
    typeof from.longitude !== "number" ||
    typeof to.latitude !== "number" ||
    typeof to.longitude !== "number"
  ) {
    // No coordinates (the current bus/metro data set). A zero heuristic makes
    // this Dijkstra, which is correct -- just not guided.
    return 0;
  }
  return haversineDistanceMeters(
    { latitude: from.latitude, longitude: from.longitude },
    { latitude: to.latitude, longitude: to.longitude },
  ) / MAX_SPEED_METERS_PER_MINUTE;
}

/**
 * Whether an edge may be used given the requested mode filter.
 *
 * A transfer edge is allowed only when both of its endpoints are reachable
 * under the filter, so `mode=BUS` cannot silently hop onto the Metro.
 */
function edgeAllowed(edge: GraphEdge, graph: TransportGraph, modes: "ALL" | TransportMode): boolean {
  if (modes === "ALL") return true;
  const from = graph.getNode(edge.fromNodeId);
  const to = graph.getNode(edge.toNodeId);
  if (!from || !to) return false;
  if (isTransferEdge(edge)) {
    return from.mode === modes && to.mode === modes;
  }
  return edge.mode === modes;
}

interface QueueEntry {
  nodeId: string;
  /**
   * Line of the ride that arrived here, or undefined after a transfer edge.
   * Part of the search state: the cost of the next edge depends on whether it
   * continues the current ride or changes lines.
   */
  lastRouteId: string | undefined;
  cost: number;
}

class MinHeap {
  private readonly items: QueueEntry[] = [];

  get size(): number {
    return this.items.length;
  }

  push(entry: QueueEntry): void {
    this.items.push(entry);
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.items[parent]!.cost <= this.items[index]!.cost) break;
      const swap = this.items[parent]!;
      this.items[parent] = this.items[index]!;
      this.items[index] = swap;
      index = parent;
    }
  }

  pop(): QueueEntry | undefined {
    if (this.items.length === 0) return undefined;
    const top = this.items[0]!;
    const last = this.items.pop()!;
    if (this.items.length > 0) {
      this.items[0] = last;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < this.items.length && this.items[left]!.cost < this.items[smallest]!.cost) {
          smallest = left;
        }
        if (right < this.items.length && this.items[right]!.cost < this.items[smallest]!.cost) {
          smallest = right;
        }
        if (smallest === index) break;
        const swap = this.items[smallest]!;
        this.items[smallest] = this.items[index]!;
        this.items[index] = swap;
        index = smallest;
      }
    }
    return top;
  }
}

/**
 * A search state is a node plus the line the traveller arrived on.
 *
 * Arriving at the same station on two different lines gives two different
 * distances, because changing lines afterwards costs an interchange. Keying the
 * search on the node alone would collapse them and let the search "teleport"
 * between lines for free.
 */
function stateKey(nodeId: string, lastRouteId: string | undefined): string {
  return `${nodeId}\u0000${lastRouteId ?? ""}`;
}

export function findPath(
  graph: TransportGraph,
  fromNodeId: string,
  toNodeId: string,
  options: PathfindingOptions = {},
): PathResult {
  const strategy: JourneyStrategy = options.strategy ?? "MIN_TIME";
  const modes = options.modes ?? "ALL";
  const maxExpansions = options.maxExpansions ?? 200_000;
  const penalty = TRANSFER_PENALTY[strategy];

  if (!graph.getNode(fromNodeId) || !graph.getNode(toNodeId)) {
    return {
      found: false,
      steps: [],
      totalTimeMinutes: 0,
      transfers: 0,
      nodesExplored: 0,
      reason: "ENDPOINT_UNKNOWN",
    };
  }

  if (fromNodeId === toNodeId) {
    return { found: true, steps: [], totalTimeMinutes: 0, transfers: 0, nodesExplored: 0 };
  }

  const startKey = stateKey(fromNodeId, undefined);
  const gScore = new Map<string, number>([[startKey, 0]]);
  const cameFrom = new Map<string, { stateKey: string; nodeId: string; edge: GraphEdge }>();
  const open = new MinHeap();
  const closed = new Set<string>();

  open.push({ nodeId: fromNodeId, lastRouteId: undefined, cost: heuristic(graph, fromNodeId, toNodeId) });

  let nodesExplored = 0;
  let searchLimitHit = false;

  while (open.size > 0) {
    const current = open.pop()!;
    const currentKey = stateKey(current.nodeId, current.lastRouteId);
    if (closed.has(currentKey)) continue;
    closed.add(currentKey);
    nodesExplored += 1;

    if (current.nodeId === toNodeId) {
      return reconstruct(graph, cameFrom, currentKey, fromNodeId, nodesExplored);
    }

    if (nodesExplored >= maxExpansions) {
      searchLimitHit = true;
      break;
    }

    const currentG = gScore.get(currentKey)!;

    for (const edge of graph.neighbours(current.nodeId)) {
      if (!edgeAllowed(edge, graph, modes)) continue;

      const time = edgeTimeMinutes(edge);
      let cost = time;
      if (isTransferEdge(edge)) {
        cost += penalty;
      } else if (current.lastRouteId !== undefined && current.lastRouteId !== edge.routeId) {
        // Changing lines still costs an interchange even when no TRANSFER edge
        // is involved, because the traveller gets off one vehicle and waits for
        // the next. The journey planner charges for exactly this when it builds
        // the segments, so the search has to price it too. Without this the
        // search treats every line as free to hop onto for a single hop, and
        // then bills the traveller 5 minutes per change afterwards.
        cost += penalty;
      }

      const tentative = currentG + cost;
      // A transfer edge ends the current ride, so the next one starts fresh.
      const nextRouteId = isTransferEdge(edge) ? undefined : edge.routeId;
      const nextKey = stateKey(edge.toNodeId, nextRouteId);

      const known = gScore.get(nextKey);
      if (known !== undefined && tentative >= known) continue;

      gScore.set(nextKey, tentative);
      cameFrom.set(nextKey, { stateKey: currentKey, nodeId: current.nodeId, edge });
      open.push({
        nodeId: edge.toNodeId,
        lastRouteId: nextRouteId,
        cost: tentative + heuristic(graph, edge.toNodeId, toNodeId),
      });
    }
  }

  return {
    found: false,
    steps: [],
    totalTimeMinutes: 0,
    transfers: 0,
    nodesExplored,
    reason: searchLimitHit ? "SEARCH_LIMIT" : "NO_PATH",
  };
}

function reconstruct(
  graph: TransportGraph,
  cameFrom: Map<string, { stateKey: string; nodeId: string; edge: GraphEdge }>,
  toStateKey: string,
  fromNodeId: string,
  nodesExplored: number,
): PathResult {
  const steps: PathStep[] = [];
  let cursor: string | undefined = toStateKey;

  while (cursor !== undefined) {
    const previous = cameFrom.get(cursor);
    if (!previous) {
      return {
        found: false,
        steps: [],
        totalTimeMinutes: 0,
        transfers: 0,
        nodesExplored,
        reason: "NO_PATH",
      };
    }
    steps.push({ edge: previous.edge, fromNodeId: previous.nodeId, toNodeId: previous.edge.toNodeId });
    if (previous.nodeId === fromNodeId) break;
    cursor = previous.stateKey;
  }

  steps.reverse();

  const totalTimeMinutes = steps.reduce((sum, step) => sum + edgeTimeMinutes(step.edge), 0);
  // An interchange is either an explicit transfer edge or a change of line, so
  // both are counted. This is what the planner reports to the caller.
  const transfers = steps.filter((step, index) => {
    if (isTransferEdge(step.edge)) return true;
    const previous = steps[index - 1];
    return previous !== undefined && !isTransferEdge(previous.edge) && previous.edge.routeId !== step.edge.routeId;
  }).length;

  return {
    found: true,
    steps,
    // Stored to 2 decimals to keep the JSON payload clean; the underlying value
    // is a sum of per-hop estimates.
    totalTimeMinutes: Math.round(totalTimeMinutes * 100) / 100,
    transfers,
    nodesExplored,
  };
}

/**
 * Finds the best path across several candidate origin nodes and several
 * candidate destination nodes, returning the cheapest combination.
 *
 * The planner resolves a user-typed place name to multiple graph nodes (for
 * example "Esplanade" exists as both a bus stop and a Metro station) and then has
 * to pick the pairing that actually connects.
 */
export function findBestPathAcross(
  graph: TransportGraph,
  fromNodeIds: string[],
  toNodeIds: string[],
  options: PathfindingOptions = {},
): { result: PathResult; fromNodeId: string; toNodeId: string } | null {
  let best: { result: PathResult; fromNodeId: string; toNodeId: string } | null = null;

  // Cap the combination count: a very generic name can resolve to many nodes
  // and the search is quadratic in candidates.
  const MAX_PAIRS = 64;
  let pairs = 0;

  for (const fromNodeId of fromNodeIds) {
    for (const toNodeId of toNodeIds) {
      if (fromNodeId === toNodeId) continue;
      if (pairs >= MAX_PAIRS) return best;
      pairs += 1;
      const result = findPath(graph, fromNodeId, toNodeId, options);
      if (!result.found) continue;
      if (best === null || isBetter(result, best.result, options.strategy ?? "MIN_TIME")) {
        best = { result, fromNodeId, toNodeId };
      }
    }
  }

  return best;
}

function isBetter(candidate: PathResult, incumbent: PathResult, strategy: JourneyStrategy): boolean {
  if (strategy === "MIN_INTERCHANGE") {
    if (candidate.transfers !== incumbent.transfers) return candidate.transfers < incumbent.transfers;
    return candidate.totalTimeMinutes < incumbent.totalTimeMinutes;
  }
  if (Math.abs(candidate.totalTimeMinutes - incumbent.totalTimeMinutes) > 0.01) {
    return candidate.totalTimeMinutes < incumbent.totalTimeMinutes;
  }
  return candidate.transfers < incumbent.transfers;
}

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
    // No coordinates (the current bus/tram data set). A zero heuristic makes
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
 * under the filter, so `mode=BUS` cannot silently hop onto a tram.
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

  const gScore = new Map<string, number>([[fromNodeId, 0]]);
  const cameFrom = new Map<string, { nodeId: string; edge: GraphEdge }>();
  const open = new MinHeap();
  const closed = new Set<string>();

  open.push({ nodeId: fromNodeId, cost: heuristic(graph, fromNodeId, toNodeId) });

  let nodesExplored = 0;
  let searchLimitHit = false;

  while (open.size > 0) {
    const current = open.pop()!;
    if (closed.has(current.nodeId)) continue;
    closed.add(current.nodeId);
    nodesExplored += 1;

    if (current.nodeId === toNodeId) {
      return reconstruct(graph, cameFrom, fromNodeId, toNodeId, nodesExplored);
    }

    if (nodesExplored >= maxExpansions) {
      searchLimitHit = true;
      break;
    }

    const currentG = gScore.get(current.nodeId)!;

    for (const edge of graph.neighbours(current.nodeId)) {
      if (!edgeAllowed(edge, graph, modes)) continue;

      const time = edgeTimeMinutes(edge);
      const cost = time + (isTransferEdge(edge) ? penalty : 0);
      const tentative = currentG + cost;

      const known = gScore.get(edge.toNodeId);
      if (known !== undefined && tentative >= known) continue;

      gScore.set(edge.toNodeId, tentative);
      cameFrom.set(edge.toNodeId, { nodeId: current.nodeId, edge });
      open.push({ nodeId: edge.toNodeId, cost: tentative + heuristic(graph, edge.toNodeId, toNodeId) });
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
  cameFrom: Map<string, { nodeId: string; edge: GraphEdge }>,
  fromNodeId: string,
  toNodeId: string,
  nodesExplored: number,
): PathResult {
  const steps: PathStep[] = [];
  let cursor = toNodeId;

  while (cursor !== fromNodeId) {
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
    steps.push({
      edge: previous.edge,
      fromNodeId: previous.nodeId,
      toNodeId: cursor,
    });
    cursor = previous.nodeId;
  }

  steps.reverse();

  const totalTimeMinutes = steps.reduce((sum, step) => sum + edgeTimeMinutes(step.edge), 0);
  const transfers = steps.filter((step) => isTransferEdge(step.edge)).length;

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
 * example "Esplanade" exists as both a bus stop and a tram stop) and then has
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

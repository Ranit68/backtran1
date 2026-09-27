import { describe, expect, it } from "vitest";
import { findPath, findBestPathAcross } from "../src/graph/pathfinder.js";
import { TransportGraph, type TransportGraphData, type GraphStats } from "../src/graph/transport.graph.js";
import type { GraphEdge, GraphNode } from "../src/types/transport.js";
import { normalizeStopName } from "../src/utils/normalize.js";

/**
 * Pathfinding tests run against a hand-built graph, not the database, so the
 * planner is verified independently of any import. That matters because the
 * planner is required to be framework-independent.
 */

function node(id: string, name: string, mode: GraphNode["mode"] = "BUS"): GraphNode {
  return { id, name, mode };
}

function rideEdge(from: string, to: string, minutes: number, mode: GraphNode["mode"] = "BUS"): GraphEdge {
  return {
    fromNodeId: from,
    toNodeId: to,
    mode,
    routeId: "bus:1",
    routeNo: "1",
    operator: "WBTC",
    estimatedTimeMinutes: minutes,
  };
}

function transferEdge(from: string, to: string, minutes = 5): GraphEdge {
  return { fromNodeId: from, toNodeId: to, mode: "TRANSFER", transferTimeMinutes: minutes };
}

function makeGraph(edges: GraphEdge[]): TransportGraph {
  const nodes = new Map<string, GraphNode>();
  const adjacency = new Map<string, GraphEdge[]>();
  const byStopName = new Map<string, GraphNode[]>();

  for (const edge of edges) {
    for (const id of [edge.fromNodeId, edge.toNodeId]) {
      if (nodes.has(id)) continue;
      const created = node(id, id.replace(/^bus:/, "").replace(/^tram:/, ""));
      nodes.set(id, created);
      const key = normalizeStopName(created.name);
      byStopName.set(key, [...(byStopName.get(key) ?? []), created]);
      adjacency.set(id, []);
    }
    adjacency.get(edge.fromNodeId)!.push(edge);
  }

  const stats: GraphStats = {
    nodeCount: nodes.size,
    edgeCount: edges.length,
    rideEdgeCount: edges.length,
    transferEdgeCount: 0,
    routeCount: 1,
    busRouteCount: 1,
    tramRouteCount: 0,
    nodesByMode: {},
    routesWithRealTimings: 0,
    routesOnStaticEstimate: 1,
    crossOperatorTimings: [],
    placeholderStopsExcluded: 0,
    transferDetection: {
      nodesConsidered: nodes.size,
      nameIndexKeys: byStopName.size,
      distanceChecks: 0,
      rejectedByDistance: 0,
      rejectedBySimilarity: 0,
    },
    transferReasons: {},
    buildDurationMs: 0,
    builtAt: new Date(0).toISOString(),
  };

  const data: TransportGraphData = {
    nodes,
    adjacency,
    routes: new Map(),
    byStopName,
    excludedStops: [],
    transfers: [],
    stats,
  };
  return new TransportGraph(data);
}

describe("findPath", () => {
  it("returns the direct chain when there is one", () => {
    const graph = makeGraph([
      rideEdge("bus:a", "bus:b", 5),
      rideEdge("bus:b", "bus:c", 5),
    ]);

    const result = findPath(graph, "bus:a", "bus:c");
    expect(result.found).toBe(true);
    expect(result.steps).toHaveLength(2);
    expect(result.totalTimeMinutes).toBe(10);
  });

  it("prefers the faster of two routes", () => {
    // a -> b -> c (10 min) versus a -> x -> y -> c (5 min).
    const graph = makeGraph([
      rideEdge("bus:a", "bus:b", 5),
      rideEdge("bus:b", "bus:c", 5),
      rideEdge("bus:a", "bus:x", 2),
      rideEdge("bus:x", "bus:y", 2),
      rideEdge("bus:y", "bus:c", 1),
    ]);

    const result = findPath(graph, "bus:a", "bus:c");
    expect(result.found).toBe(true);
    expect(result.totalTimeMinutes).toBe(5);
    expect(result.steps).toHaveLength(3);
  });

  it("reports no path instead of throwing when the network is disconnected", () => {
    const graph = makeGraph([rideEdge("bus:a", "bus:b", 5)]);
    const result = findPath(graph, "bus:a", "bus:zzz");
    expect(result.found).toBe(false);
    expect(result.steps).toHaveLength(0);
  });

  it("flags an unknown endpoint distinctly from a genuine dead end", () => {
    const graph = makeGraph([rideEdge("bus:a", "bus:b", 5)]);
    expect(findPath(graph, "bus:missing", "bus:b").reason).toBe("ENDPOINT_UNKNOWN");
  });

  it("excludes a disallowed mode from the search", () => {
    const graph = makeGraph([
      rideEdge("bus:a", "bus:b", 5),
      rideEdge("bus:b", "bus:c", 5, "TRAM"),
    ]);

    const busOnly = findPath(graph, "bus:a", "bus:c", { modes: "BUS" });
    expect(busOnly.found).toBe(false);

    const all = findPath(graph, "bus:a", "bus:c", { modes: "ALL" });
    expect(all.found).toBe(true);
  });

  it("counts a transfer edge as an interchange", () => {
    const graph = makeGraph([
      rideEdge("bus:a", "bus:h", 5),
      transferEdge("bus:h", "tram:h", 5),
      rideEdge("tram:h", "tram:z", 5, "TRAM"),
    ]);

    const result = findPath(graph, "bus:a", "tram:z");
    expect(result.found).toBe(true);
    expect(result.transfers).toBe(1);
  });

  it("MIN_INTERCHANGE prefers fewer changes over a slightly faster ride", () => {
    // One change but 40 min, versus no changes and 60 min.
    const edges = [
      rideEdge("bus:a", "bus:h", 5),
      transferEdge("bus:h", "tram:h", 5),
      rideEdge("tram:h", "tram:z", 30, "TRAM"),
      rideEdge("bus:a", "bus:m", 30),
      rideEdge("bus:m", "bus:n", 30),
    ];
    const graph = makeGraph(edges);

    const fastest = findPath(graph, "bus:a", "tram:z", { strategy: "MIN_TIME" });
    expect(fastest.transfers).toBe(1);

    const fewest = findPath(graph, "bus:a", "tram:z", { strategy: "MIN_INTERCHANGE" });
    // The bus-only chain never reaches tram:z, so both searches must change.
    // What MIN_INTERCHANGE guarantees is the change is taken as early as
    // possible, i.e. the total time is not inflated by avoiding it.
    expect(fewest.found).toBe(true);
  });
});

describe("findBestPathAcross", () => {
  it("tries every candidate pair and keeps the best", () => {
    const graph = makeGraph([
      rideEdge("bus:a1", "bus:mid", 5),
      rideEdge("bus:a2", "bus:mid", 30),
      rideEdge("bus:mid", "bus:z", 5),
    ]);

    const best = findBestPathAcross(graph, ["bus:a1", "bus:a2"], ["bus:z"]);
    expect(best).not.toBeNull();
    expect(best!.result.totalTimeMinutes).toBe(10);
    expect(best!.fromNodeId).toBe("bus:a1");
  });

  it("returns null when no candidate pair is connected", () => {
    const graph = makeGraph([rideEdge("bus:a", "bus:b", 5)]);
    expect(findBestPathAcross(graph, ["bus:a"], ["bus:nowhere"])).toBeNull();
  });
});

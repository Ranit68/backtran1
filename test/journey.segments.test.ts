import { describe, expect, it } from "vitest";
import { createRouteStatsLookup, TransportGraph, type TransportGraphData } from "../src/graph/transport.graph.js";
import { findPath } from "../src/graph/pathfinder.js";
import type { RideEdge } from "../src/graph/graph.edge.js";
import { JourneyService, type TimetableIndex } from "../src/services/journey.service.js";
import type { RouteTripStatsRow } from "../src/models/bus.model.js";
import type { GraphEdge, GraphNode, JourneySegment } from "../src/types/transport.js";
import { normalizeStopName } from "../src/utils/normalize.js";

/**
 * Regression tests for two defects found by running the API against the real
 * Supabase data, both of which had silently produced plausible-looking wrong
 * answers rather than errors.
 */

function stat(row: Partial<RouteTripStatsRow> & { route_no: string }): RouteTripStatsRow {
  return {
    operator: "CSTC",
    mode: "BUS",
    sample_count: 10,
    avg_trip_minutes: 60,
    min_trip_minutes: 50,
    max_trip_minutes: 70,
    updated_at: new Date(0).toISOString(),
    ...row,
  } as RouteTripStatsRow;
}

// ---------------------------------------------------------------------------
// Route timing statistics lookup
// ---------------------------------------------------------------------------

describe("createRouteStatsLookup", () => {
  it("matches on the exact operator when the two files agree", () => {
    const lookup = createRouteStatsLookup([stat({ operator: "WBTC", route_no: "AC-3", avg_trip_minutes: 69 })]);
    expect(lookup.match("WBTC", "AC-3")?.avg_trip_minutes).toBe(69);
    expect(lookup.crossOperatorMatches).toEqual([]);
  });

  it("matches across operators when a route number is claimed by exactly one", () => {
    // The live case: route stops say WBTC, the timetable says CSTC.
    const lookup = createRouteStatsLookup([stat({ operator: "CSTC", route_no: "AC-3", avg_trip_minutes: 69 })]);
    expect(lookup.match("WBTC", "AC-3")?.avg_trip_minutes).toBe(69);
    expect(lookup.crossOperatorMatches).toEqual(["WBTC:AC-3 -> CSTC"]);
  });

  it("refuses to match when two operators claim the same route number", () => {
    // Averaging or picking one of these would be inventing data.
    const lookup = createRouteStatsLookup([
      stat({ operator: "WBTC", route_no: "AC-3", avg_trip_minutes: 60 }),
      stat({ operator: "CSTC", route_no: "AC-3", avg_trip_minutes: 80 }),
    ]);
    expect(lookup.match("WBTC", "AC-3")?.avg_trip_minutes).toBe(60);
    expect(lookup.match("CSTC", "AC-3")?.avg_trip_minutes).toBe(80);
    expect(lookup.match("OTHER", "AC-3")).toBeNull();
  });

  it("returns null for a route with no statistics at all", () => {
    const lookup = createRouteStatsLookup([stat({ route_no: "AC-3" })]);
    expect(lookup.match("WBTC", "11A")).toBeNull();
  });

  it("does not adopt a cross-operator row that has no usable duration", () => {
    const lookup = createRouteStatsLookup([stat({ route_no: "AC-3", avg_trip_minutes: null })]);
    expect(lookup.match("WBTC", "AC-3")).toBeNull();
    expect(lookup.crossOperatorMatches).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Journey segmentation
// ---------------------------------------------------------------------------

function node(id: string, name: string, mode: GraphNode["mode"] = "BUS"): GraphNode {
  return { id, name, mode };
}

function rideEdge(
  from: string,
  to: string,
  minutes: number,
  routeNo: string,
  routeId = `bus:wbtc:route:${routeNo.toLowerCase()}`,
): RideEdge {
  return {
    fromNodeId: from,
    toNodeId: to,
    mode: "BUS",
    routeId,
    routeNo,
    operator: "WBTC",
    estimatedTimeMinutes: minutes,
    fromHop: 0,
    toHop: 1,
    totalHops: 2,
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
      const created = node(id, id);
      nodes.set(id, created);
      const key = normalizeStopName(created.name);
      byStopName.set(key, [...(byStopName.get(key) ?? []), created]);
      adjacency.set(id, []);
    }
    adjacency.get(edge.fromNodeId)!.push(edge);
  }

  const data: TransportGraphData = {
    nodes,
    adjacency,
    routes: new Map(),
    byStopName,
    excludedStops: [],
    transfers: [],
    stats: {
      nodeCount: nodes.size,
      edgeCount: edges.length,
      rideEdgeCount: edges.length,
      transferEdgeCount: 0,
      routeCount: 2,
      busRouteCount: 2,
    metroLineCount: 0,
    ferryRouteCount: 0,
    ferryRoutesExcludedNotOperational: 0,
    tramRouteCount: 0,
    tramRoutesExcludedNotOperational: 0,
    routesOnLegEstimates: 0,
    orphanLegRouteIds: [],
    metroLinesWithoutTimetable: [],
      nodesByMode: {},
      routesWithRealTimings: 0,
      routesOnStaticEstimate: 2,
      crossOperatorTimings: [],
      placeholderStopsExcluded: 0,
      transferDetection: {
        nodesConsidered: nodes.size,
        nameIndexKeys: byStopName.size,
        distanceChecks: 0,
        rejectedByDistance: 0,
        rejectedBySimilarity: 0,
        rejectedSameSystem: 0,
      },
      transferReasons: {},
      buildDurationMs: 0,
      builtAt: new Date(0).toISOString(),
    },
  };
  return new TransportGraph(data);
}

type SegmentBuilder = (
  graph: TransportGraph,
  result: ReturnType<typeof findPath>,
  context: { timetable: TimetableIndex; requestMinutes: number | null; warnings: string[] },
) => { segments: JourneySegment[]; clockMinutes: number[] };

/** No real timetable data, so every leg falls back to the graph estimate. */
function emptyTimetable(): TimetableIndex {
  return {
    byRouteNo: new Map(),
    unresolvedRoutes: [],
    metroByLeg: new Map(),
    metroLinesWithoutTimetable: [],
  };
}

/** Reaches the private segmentation step, which is the unit under test. */
const journeyService = new JourneyService();
const buildSegments = (journeyService["buildSegments"] as unknown as SegmentBuilder).bind(journeyService);

function segmentModes(segments: JourneySegment[]): string[] {
  return segments.map((segment) => segment.mode);
}

describe("journey segmentation", () => {
  it("counts a change of bus at the same stop as an interchange", () => {
    // The live defect: E-26 to C-8 at E.M.Bypass produced a two-bus journey
    // with interchangeCount 0 and no time for changing vehicles.
    const graph = makeGraph([
      rideEdge("Esplanade", "E.M.Bypass", 7, "E-26"),
      rideEdge("E.M.Bypass", "Gariahat", 8, "C-8"),
    ]);
    const path = findPath(graph, "Esplanade", "Gariahat");
    expect(path.found).toBe(true);

    const { segments } = buildSegments(graph, path, {
      timetable: emptyTimetable(),
      requestMinutes: null,
      warnings: [],
    });

    expect(segmentModes(segments)).toEqual(["BUS", "TRANSFER", "BUS"]);
    const rides = segments.filter((segment) => segment.mode === "BUS");
    expect(rides).toHaveLength(2);
    // Every boundary between two rides is an interchange.
    expect(Math.max(0, rides.length - 1)).toBe(1);

    const changeover = segments.find((segment) => segment.mode === "TRANSFER")!;
    expect(changeover.from).toBe("E.M.Bypass");
    expect(changeover.to).toBe("E.M.Bypass");
    expect(changeover.estimatedMinutes).toBeGreaterThan(0);
    // An allowance, never presented as measured data.
    expect(changeover.timingConfidence).toBe("ESTIMATED");
  });

  it("adds changeover time to the journey total, not just the segment list", () => {
    const graph = makeGraph([
      rideEdge("A", "B", 7, "E-26"),
      rideEdge("B", "C", 8, "C-8"),
    ]);
    const path = findPath(graph, "A", "C");
    const { segments } = buildSegments(graph, path, {
      timetable: emptyTimetable(),
      requestMinutes: null,
      warnings: [],
    });

    const ridingMinutes = segments
      .filter((segment) => segment.mode === "BUS")
      .reduce((sum, segment) => sum + (segment.estimatedMinutes ?? 0), 0);
    const changeoverMinutes = segments
      .filter((segment) => segment.mode === "TRANSFER")
      .reduce((sum, segment) => sum + (segment.estimatedMinutes ?? 0), 0);
    const total = segments.reduce((sum, segment) => sum + (segment.estimatedMinutes ?? 0), 0);

    // The journey must cost more than the riding time alone; the changeover is
    // part of the trip, not a footnote.
    expect(changeoverMinutes).toBeGreaterThan(0);
    expect(total).toBe(ridingMinutes + changeoverMinutes);
    expect(total).toBeGreaterThan(ridingMinutes);
  });

  it("reports no interchange for a single ride", () => {
    const graph = makeGraph([rideEdge("A", "B", 7, "E-26"), rideEdge("B", "C", 7, "E-26")]);
    const path = findPath(graph, "A", "C");
    const { segments } = buildSegments(graph, path, {
      timetable: emptyTimetable(),
      requestMinutes: null,
      warnings: [],
    });
    expect(segmentModes(segments)).toEqual(["BUS"]);
    expect(Math.max(0, segments.length - 1)).toBe(0);
  });

  it("uses a WALK leg, not a second changeover, when the stops differ", () => {
    // A transfer edge already represents the walk plus the wait, so adding a
    // TRANSFER segment on top would double-count the interchange.
    const graph = makeGraph([
      rideEdge("A", "B", 7, "E-26"),
      transferEdge("B", "C", 4),
      rideEdge("C", "D", 6, "C-8"),
    ]);
    const path = findPath(graph, "A", "D");
    const { segments } = buildSegments(graph, path, {
      timetable: emptyTimetable(),
      requestMinutes: null,
      warnings: [],
    });
    expect(segmentModes(segments)).toEqual(["BUS", "WALK", "BUS"]);
    expect(segments.filter((segment) => segment.mode === "TRANSFER")).toHaveLength(0);
  });

  it("keeps a single ride together across several hops", () => {
    const graph = makeGraph([
      rideEdge("A", "B", 7, "E-26"),
      rideEdge("B", "C", 7, "E-26"),
      rideEdge("C", "D", 7, "E-26"),
    ]);
    const path = findPath(graph, "A", "D");
    const { segments } = buildSegments(graph, path, {
      timetable: emptyTimetable(),
      requestMinutes: null,
      warnings: [],
    });
    expect(segmentModes(segments)).toEqual(["BUS"]);
    expect(segments[0]!.stops).toEqual(["A", "B", "C", "D"]);
  });
});

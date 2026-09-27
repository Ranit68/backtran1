import { describe, expect, it } from "vitest";
import { TransportGraph, type RouteInfo, type TransportGraphData } from "../src/graph/transport.graph.js";
import { findPath } from "../src/graph/pathfinder.js";
import type { RideEdge } from "../src/graph/graph.edge.js";
import { JourneyService, type TimetableIndex } from "../src/services/journey.service.js";
import type { MetroLegRun } from "../src/repositories/metro.repository.js";
import type { GraphEdge, GraphNode, JourneySegment } from "../src/types/transport.js";
import { buildStopNodeId, normalizeStopName } from "../src/utils/normalize.js";

/**
 * Metro journey timing.
 *
 * The Metro source is not uniform, and the point of these tests is that the
 * planner labels each case for what it actually is rather than presenting one
 * confident number:
 *
 *  - The timetable prints a departure per station, so a boarding time is
 *    normally real.
 *  - It prints exactly one arrival per run, at that run's terminus, so there is
 *    no printed arrival to quote for a station in the middle of a line.
 *  - A run's identity needs the whole (line, trip_id, service_day, direction)
 *    tuple, because `trip_id` alone repeats across service days.
 *  - A line with no timetable at all must stay a static estimate.
 */

const LINE = "BLUE";
const MIN_PER_HOP = 3.372;

/** Three stations in line order. 0-based positions match the source sequence. */
const ESPLANADE = "Esplanade";
const PARK_STREET = "Park Street";
const NOAPARA = "Noapara";

/** Built by the real helper, so the ids match what a client is handed. */
function id(name: string): string {
  return buildStopNodeId("METRO", "Metro Railway", name);
}

function metroRide(from: string, to: string, fromHop: number, toHop: number, minutes: number): RideEdge {
  return {
    fromNodeId: id(from),
    toNodeId: id(to),
    mode: "METRO",
    routeId: "metro:blue",
    routeNo: LINE,
    operator: "Metro Railway",
    estimatedTimeMinutes: minutes,
    fromHop,
    toHop,
    totalHops: 3,
  };
}

/** Esplanade -> Park Street, one hop, priced at the measured per-hop time. */
const EDGES = [metroRide(ESPLANADE, PARK_STREET, 0, 1, MIN_PER_HOP)];

function makeMetroGraph(edges: RideEdge[]): TransportGraph {
  const nodes = new Map<string, GraphNode>();
  const adjacency = new Map<string, GraphEdge[]>();
  const byStopName = new Map<string, GraphNode[]>();

  for (const [name, nodeId] of [
    [ESPLANADE, id(ESPLANADE)],
    [PARK_STREET, id(PARK_STREET)],
  ] as [string, string][]) {
    const created: GraphNode = { id: nodeId, name, mode: "METRO", operator: "Metro Railway" };
    nodes.set(nodeId, created);
    const key = normalizeStopName(name);
    byStopName.set(key, [...(byStopName.get(key) ?? []), created]);
    adjacency.set(nodeId, []);
  }

  for (const edge of edges) adjacency.get(edge.fromNodeId)!.push(edge);

  const routes = new Map<string, RouteInfo>();
  routes.set("metro:blue", {
    routeId: "metro:blue",
    mode: "METRO",
    routeNo: LINE,
    operator: "Metro Railway",
    minutesPerHop: MIN_PER_HOP,
    stopNodeIds: [id(ESPLANADE), id(PARK_STREET), id(NOAPARA)],
    stopNames: [ESPLANADE, PARK_STREET, NOAPARA],
    totalHops: 2,
    // The graph prices Metro from times printed between adjacent stations, so
    // this is measured data rather than a configured default.
    timeSource: "TIMETABLE_AVERAGE",
    averageTripMinutes: null,
  });

  const data: TransportGraphData = {
    nodes,
    adjacency,
    routes,
    byStopName,
    excludedStops: [],
    transfers: [],
    stats: {
      nodeCount: nodes.size,
      edgeCount: edges.length,
      rideEdgeCount: edges.length,
      transferEdgeCount: 0,
      routeCount: 1,
      busRouteCount: 0,
      metroLineCount: 1,
      metroLinesWithoutTimetable: [],
      nodesByMode: { METRO: nodes.size },
      routesWithRealTimings: 1,
      routesOnStaticEstimate: 0,
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

const journeyService = new JourneyService();
const buildSegments = (journeyService["buildSegments"] as unknown as SegmentBuilder).bind(journeyService);

/** Keyed exactly as the planner keys it: line, then both station names. */
function legKey(from: string, to: string): string {
  return `${LINE}|${from.toLowerCase()}|${to.toLowerCase()}`;
}

function timetableWith(runs: MetroLegRun[], linesWithoutTimetable: string[] = []): TimetableIndex {
  return {
    byRouteNo: new Map(),
    unresolvedRoutes: [],
    metroByLeg: new Map([[legKey(ESPLANADE, PARK_STREET), runs]]),
    metroLinesWithoutTimetable: linesWithoutTimetable,
  };
}

/** A real-shaped run: prints its origin departure, no printed mid-line arrival. */
function run(overrides: Partial<MetroLegRun> = {}): MetroLegRun {
  return {
    line: LINE,
    tripId: "1001",
    trainNo: "1234",
    serviceDay: "WEEKDAY",
    direction: "DOWN",
    runOrigin: ESPLANADE,
    runDestination: NOAPARA,
    originPosition: 1,
    destinationPosition: 3,
    runHops: 2,
    boardPosition: 1,
    alightPosition: 2,
    legHops: 1,
    runDepartureTime: "10:00:00",
    runArrivalTime: "10:07:00",
    runDurationMinutes: 7,
    boardTime: "10:00:00",
    alightTime: null,
    ...overrides,
  };
}

function plan(
  runs: MetroLegRun[],
  options: { requestMinutes?: number | null; linesWithoutTimetable?: string[] } = {},
) {
  const graph = makeMetroGraph(EDGES);
  const path = findPath(graph, id(ESPLANADE), id(PARK_STREET));
  expect(path.found).toBe(true);

  const warnings: string[] = [];
  const { segments } = buildSegments(graph, path, {
    timetable: timetableWith(runs, options.linesWithoutTimetable),
    requestMinutes: options.requestMinutes ?? null,
    warnings,
  });
  return { segment: segments[0]!, segments, warnings };
}

describe("Metro journey timing", () => {
  it("reports an exact leg as EXACT only when both ends are printed", () => {
    // Alighting at the run's terminus is the one case with a printed arrival.
    const { segment } = plan([run({ boardTime: "10:02:00", alightTime: "10:05:00" })]);

    expect(segment.timingConfidence).toBe("EXACT");
    expect(segment.departureTime).toBe("10:02");
    expect(segment.arrivalTime).toBe("10:05");
    expect(segment.estimatedMinutes).toBe(3);
  });

  it("scales along the run's real duration when the alighting time is not printed", () => {
    // The source prints one arrival per run, at its terminus, so a mid-line
    // alighting time can only be interpolated. It must not claim EXACT.
    const { segment } = plan([run({ boardTime: "10:02:00" })]);

    expect(segment.timingConfidence).toBe("SCALED");
    expect(segment.departureTime).toBe("10:02");
    // Half of the 7-minute, 2-hop run: 7 * 1/2 = 3.5, rounded to 4.
    expect(segment.estimatedMinutes).toBe(4);
    expect(segment.arrivalTime).toBe("10:06");
  });

  it("keeps the real boarding time when boarding part-way into a run", () => {
    // Boarding two hops into a five-hop run: 11 * 2/5 = 4.4 min after departure.
    const { segment } = plan([
      run({
        destinationPosition: 6,
        runHops: 5,
        boardPosition: 3,
        alightPosition: 4,
        runDurationMinutes: 11,
        runArrivalTime: "10:11:00",
        boardTime: "10:04:24",
      }),
    ]);

    expect(segment.timingConfidence).toBe("SCALED");
    expect(segment.departureTime).toBe("10:04");
    expect(segment.estimatedMinutes).toBe(2);
  });

  it("identifies the run by the full tuple, not by trip_id alone", () => {
    const { segment } = plan([
      run({ boardTime: "10:02:00", alightTime: "10:05:00", serviceDay: "SATURDAY" }),
    ]);

    expect(segment.tripId).toBe("1001");
    expect(segment.serviceDay).toBe("SATURDAY");
    expect(segment.direction).toBe("DOWN");
  });

  it("prefers a real exact run over an earlier interpolated one", () => {
    // The interpolated run departs sooner, so choosing purely on clock time
    // would throw away a real measurement.
    const { segment } = plan([
      run({ boardTime: "10:00:00", alightTime: null, tripId: "interpolated" }),
      run({ boardTime: "10:04:00", alightTime: "10:07:00", tripId: "exact" }),
    ]);

    expect(segment.tripId).toBe("exact");
    expect(segment.timingConfidence).toBe("EXACT");
  });

  it("stays a static estimate on a line with no timetable, and says so", () => {
    const { segment, warnings } = plan([], { linesWithoutTimetable: [LINE] });

    expect(segment.timingConfidence).toBe("ESTIMATED");
    expect(segment.departureTime).toBeUndefined();
    expect(warnings.join(" ")).toContain("no timetable");
  });

  it("falls back to the graph estimate when a run has no usable duration", () => {
    const { segment } = plan([
      run({ runDurationMinutes: null, runArrivalTime: undefined, boardTime: null, alightTime: null }),
    ]);

    expect(segment.timingConfidence).toBe("ESTIMATED");
    expect(segment.estimatedMinutes).toBe(Math.round(MIN_PER_HOP));
  });

  it("reports the wait when the requested time is before the departure", () => {
    const { segment } = plan([run({ boardTime: "10:05:00", alightTime: "10:08:00" })], {
      requestMinutes: 9 * 60 + 50,
    });

    expect(segment.waitMinutes).toBe(15);
  });

  it("does not report a negative wait when the last departure has already gone", () => {
    const { segment, warnings } = plan(
      [run({ boardTime: "10:00:00", alightTime: "10:03:00" })],
      { requestMinutes: 23 * 60 + 50 },
    );

    // The last service in the loaded data has gone, so the honest answer is the
    // next service day rather than a negative wait or a past departure.
    expect(segment.waitMinutes).toBeGreaterThan(0);
    expect(warnings.join(" ")).toContain("next service day");
  });
});

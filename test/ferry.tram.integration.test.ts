import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config as loadDotenv } from "dotenv";
import type { RouteInfo, TransportGraph } from "../src/graph/transport.graph.js";
import { isRideEdge } from "../src/graph/graph.edge.js";
import type { TransportMode } from "../src/types/transport.js";

/**
 * Ferry and Tram integration tests, against the real database.
 *
 * These complement test/api.contract.test.ts rather than replacing it. The
 * contract suite pins DATABASE_URL to empty on purpose, because it asserts the
 * no-database behaviour. That makes it the wrong place to prove that a tram
 * route number resolves, that a ferry ghat is searchable, or that a journey is
 * timed from leg data -- all of which need real rows.
 *
 * So this file loads .env itself. The pinned value is removed first, because
 * dotenv will not overwrite a key that already exists in process.env.
 *
 * If no database is reachable the whole suite skips rather than failing: a
 * missing Supabase project is an environment problem, not a code defect, and a
 * red suite would say otherwise.
 */

// Must happen before the services are imported: env.ts snapshots whether a
// database is configured when it is first evaluated, so the value has to be in
// place before any import of it. Hence the dynamic imports in beforeAll.
delete process.env.DATABASE_URL;
loadDotenv();

const hasDatabase = Boolean(process.env.DATABASE_URL);

/**
 * Route records are keyed by a composite of mode, operator and route number, so
 * a test that knows only "TRAM5" or "F001" has to look the route up the same way
 * a caller would.
 */
function findRoute(graph: TransportGraph, mode: TransportMode, routeNo: string): RouteInfo | undefined {
  return [...graph.data.routes.values()].find(
    (r) => r.mode === mode && r.routeNo === routeNo,
  );
}

/** Filled in by beforeAll; typed loosely to keep this file readable. */
let app: import("fastify").FastifyInstance;
let getGraph: typeof import("../src/services/graph.service.js").getGraph;
let getSearchService: typeof import("../src/services/search.service.js").getSearchService;
let getJourneyService: typeof import("../src/services/journey.service.js").getJourneyService;
let getFerryDiagnostics: typeof import("../src/repositories/ferry.repository.js").getFerryDiagnostics;
let getTramDiagnostics: typeof import("../src/repositories/tram.repository.js").getTramDiagnostics;
let closePool: typeof import("../src/config/database.js").closePool;

beforeAll(async () => {
  if (!hasDatabase) return;
  ({ getGraph } = await import("../src/services/graph.service.js"));
  ({ getSearchService } = await import("../src/services/search.service.js"));
  ({ getJourneyService } = await import("../src/services/journey.service.js"));
  ({ getFerryDiagnostics } = await import("../src/repositories/ferry.repository.js"));
  ({ getTramDiagnostics } = await import("../src/repositories/tram.repository.js"));
  ({ closePool } = await import("../src/config/database.js"));
  const { buildApp } = await import("../src/app.js");

  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  if (app) await app.close();
  if (closePool) await closePool();
});

describe.skipIf(!hasDatabase)("Tram route resolution", () => {
  it("serves a route by its bare number and by its id, identically", async () => {
    const byNumber = await app.inject({ method: "GET", url: "/api/tram/routes/5" });
    const byId = await app.inject({ method: "GET", url: "/api/tram/routes/TRAM5" });

    expect(byNumber.statusCode).toBe(200);
    expect(byId.statusCode).toBe(200);
    // The source numbers this route "5" and identifies it as "TRAM5". A client
    // may reasonably ask for either, and they must be the same route.
    expect(byNumber.json().data.route_id).toBe("TRAM5");
    expect(byNumber.json().data).toEqual(byId.json().data);
  });

  it("resolves the second route by bare number as well", async () => {
    const response = await app.inject({ method: "GET", url: "/api/tram/routes/25" });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.route_id).toBe("TRAM25");
  });

  it("returns 404 for a route that does not exist", async () => {
    const response = await app.inject({ method: "GET", url: "/api/tram/routes/99" });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
  });

  it("orders stops by stop_sequence, not alphabetically", async () => {
    const response = await app.inject({ method: "GET", url: "/api/tram/routes/5/stops" });

    expect(response.statusCode).toBe(200);
    const stops = response.json().data.stops as { stop_name: string; stop_sequence: number }[];
    const sequences = stops.map((s) => s.stop_sequence);
    // Monotonic, which is what "in the supplied sequence order" means.
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    const names = stops.map((s) => s.stop_name);
    expect(names).not.toEqual([...names].sort());
    // Every stop must be placed, otherwise a leg cannot say which is next.
    expect(stops.every((s) => Number.isInteger(s.stop_sequence))).toBe(true);
  });
});

describe.skipIf(!hasDatabase)("Tram graph", () => {
  it("loads both operational routes and excludes the historical ones", async () => {
    const stats = (await getGraph()).data.stats;

    expect(stats.tramRouteCount).toBe(2);
    expect(stats.nodesByMode.TRAM).toBeGreaterThan(0);
    // Zero is correct here: both rows in tram_routes are operational. The eight
    // historical routes live in their own table and are counted separately, so
    // they never reach the route list at all rather than being filtered out of it.
    expect(stats.tramRoutesExcludedNotOperational).toBe(0);

    const routableTramRoutes = [...(await getGraph()).data.routes.values()]
      .filter((r) => r.mode === "TRAM")
      .map((r) => r.routeNo)
      .sort();
    expect(routableTramRoutes).toEqual(["25", "5"]);
  });

  it("builds explicit directed edges without synthesising the reverse", async () => {
    const graph = await getGraph();
    const route = findRoute(graph, "TRAM", "5");
    expect(route).toBeDefined();

    const rideEdges = graph.edges.filter(isRideEdge).filter((e) => e.routeNo === "5");

    // The source supplies 30 FORWARD and 30 REVERSE rows for this route, so the
    // graph must hold exactly 60 ride edges. Had it also synthesised a reverse
    // for each row, as it must for bus and metro, this would be 120 -- which is
    // the whole point: no direction may be invented.
    expect(rideEdges.length).toBe(60);
    expect(rideEdges.length).toBe(route!.totalHops * 2);

    // Every hop advances along the direction of travel: there is no edge whose
    // toHop is at or behind its fromHop, which is what a synthesized reverse
    // would look like. Hop indices restart per direction, so hop 0 appears twice
    // -- once for the FORWARD chain and once for the REVERSE chain.
    expect(rideEdges.some((e) => e.toHop <= e.fromHop)).toBe(false);
    expect(rideEdges.filter((e) => e.fromHop === 0).map((e) => e.toHop)).toEqual([1, 1]);
    expect(rideEdges.filter((e) => e.fromHop === 29).map((e) => e.toHop)).toEqual([30, 30]);
  });

  it("times tram routes from a static estimate, never a fixed headway", async () => {
    const route = findRoute(await getGraph(), "TRAM", "5");

    // Both services are irregular and publish no headway, so a "timetable" time
    // here would be a fabrication.
    expect(route!.timeSource).toBe("STATIC_FALLBACK");
  });
});

describe.skipIf(!hasDatabase)("Ferry graph", () => {
  it("loads the operational routes", async () => {
    const stats = (await getGraph()).data.stats;

    expect(stats.ferryRouteCount).toBe(8);
    expect(stats.nodesByMode.FERRY).toBeGreaterThan(0);
  });

  it("times ferry routes from each leg's own duration", async () => {
    const route = findRoute(await getGraph(), "FERRY", "F001");

    expect(route!.timeSource).toBe("LEG_ESTIMATE");
    expect((await getGraph()).data.stats.routesOnLegEstimates).toBeGreaterThan(0);
  });

  it("keys a ghat served by two operators as two nodes joined by a transfer", async () => {
    const graph = await getGraph();
    // Howrah is served by "WBTC" and by "WBTC/HNJPSS".
    const howrah = graph
      .findNodesByName("howrah")
      .filter((n) => n.mode === "FERRY")
      .map((n) => n.id)
      .sort();

    expect(howrah.length).toBeGreaterThan(1);
    // A walk between the two must exist, or a passenger could not change
    // operator at the ghat even though both routes call there.
    const linked = howrah.some((from) =>
      graph.neighbours(from).some((e) => e.mode === "TRANSFER" && howrah.includes(e.toNodeId)),
    );
    expect(linked).toBe(true);
  });
});

describe.skipIf(!hasDatabase)("Ferry search", () => {
  it("finds a ghat that only the leg table mentions", async () => {
    // F003 calls at "Babughat / Chandpal Ghat", a name no `ferry_ghats` row
    // carries. A search built from that master table would return nothing here
    // even though the graph can route to the place.
    const results = await getSearchService().search({ q: "Babughat", mode: "FERRY", limit: 5 });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.name).toBe("Babughat / Chandpal Ghat");
  });

  it("matches that composite name by either half, case-insensitively", async () => {
    for (const q of ["Chandpal", "babughat", "Babughat / Chandpal Ghat"]) {
      const results = await getSearchService().search({ q, mode: "FERRY", limit: 5 });
      expect(results.map((r) => r.name), q).toContain("Babughat / Chandpal Ghat");
    }
  });

  it("returns a nodeId that the graph actually contains", async () => {
    const [hit] = await getSearchService().search({ q: "Babughat", mode: "FERRY", limit: 1 });
    const graph = await getGraph();

    // A nodeId that is not routable is worse than no result at all: the client
    // shows a destination the journey planner then rejects.
    expect(hit).toBeDefined();
    expect(graph.getNode(hit!.nodeId)).toBeDefined();
  });

  it("searches a plain ghat by name", async () => {
    const results = await getSearchService().search({ q: "Armenian Ghat", mode: "FERRY", limit: 5 });
    expect(results.some((r) => r.name === "Armenian Ghat")).toBe(true);
  });
});

describe.skipIf(!hasDatabase)("Journeys", () => {
  it("routes a ferry leg and reports the leg's own duration", async () => {
    const journey = await getJourneyService().plan({
      source: "Howrah",
      destination: "Armenian Ghat",
      mode: "FERRY",
    });

    expect(journey.totalTimeMinutes).toBe(10);
    expect(journey.modesUsed).toEqual(["FERRY"]);
    expect(journey.segments[0]?.routeNo).toBe("F001");
  });

  it("routes a tram journey in both directions", async () => {
    for (const direction of [
      { source: "Shyambazar Tram Terminus", destination: "Esplanade" },
      { source: "Esplanade", destination: "Shyambazar Tram Terminus" },
    ]) {
      const journey = await getJourneyService().plan({ ...direction, mode: "TRAM" });
      expect(journey.totalTimeMinutes, direction.source).toBe(150);
    }
  });

  it("points a warning at the diagnostics endpoint for the modes used", async () => {
    const journey = await getJourneyService().plan({
      source: "Howrah",
      destination: "Armenian Ghat",
      mode: "FERRY",
    });

    // The old wording sent every reader to /api/bus/diagnostics regardless of
    // which mode they were travelling on.
    const coverage = journey.warnings.find((w) => w.includes("timetable coverage"));
    expect(coverage).toBeDefined();
    expect(coverage).toContain("/api/ferry/diagnostics");
    expect(coverage).not.toContain("/api/bus/diagnostics");
  });

  it("keeps planning multi-modal journeys across all four modes", async () => {
    const journey = await getJourneyService().plan({
      source: "Ahiritola Ghat",
      destination: "Gariahat",
      mode: "ALL",
    });

    expect(journey.totalTimeMinutes).toBe(81);
    expect([...journey.modesUsed].sort()).toEqual(["BUS", "FERRY", "METRO", "TRAM"]);
  });
});

describe.skipIf(!hasDatabase)("Data validation", () => {
  it("reports ferry data as healthy with no unfixed problems", async () => {
    const diagnostics = await getFerryDiagnostics();

    expect(diagnostics.status).toBe("healthy");
    expect(diagnostics.missingRouteReferences).toEqual([]);
    expect(diagnostics.duplicateRouteIds).toEqual([]);
    expect(diagnostics.duplicateGhatIds).toEqual([]);
    expect(diagnostics.routesWithInvalidStatus).toEqual([]);
    expect(diagnostics.legsWithNegativeDuration).toEqual([]);
    expect(diagnostics.schedulesWithNegativeFrequency).toEqual([]);
  });

  it("reports tram data as healthy with no unfixed problems", async () => {
    const diagnostics = await getTramDiagnostics();

    expect(diagnostics.status).toBe("healthy");
    expect(diagnostics.missingRouteReferences).toEqual([]);
    expect(diagnostics.duplicateStopIds).toEqual([]);
    expect(diagnostics.invalidStopSequences).toEqual([]);
    expect(diagnostics.servicesWithNegativeFrequency).toEqual([]);
  });

  it("keeps an unverified fare as unknown rather than as zero", async () => {
    const diagnostics = await getFerryDiagnostics();

    // F006 has no verified fare in the source. It must surface as "unknown".
    expect(diagnostics.routesWithUnverifiedFare).toContain("F006");
  });

  it("marks both tram services irregular so they are not read as fixed-frequency", async () => {
    const diagnostics = await getTramDiagnostics();
    expect([...diagnostics.routesWithIrregularService].sort()).toEqual(["TRAM25", "TRAM5"]);
  });
});

describe.skipIf(!hasDatabase)("Bus and Metro regression", () => {
  it("still loads bus and metro routes alongside the new modes", async () => {
    const stats = (await getGraph()).data.stats;

    expect(stats.busRouteCount).toBe(47);
    expect(stats.metroLineCount).toBe(5);
    expect(stats.nodesByMode.BUS).toBeGreaterThan(0);
    expect(stats.nodesByMode.METRO).toBeGreaterThan(0);
  });

  it("still plans a bus-only journey", async () => {
    const journey = await getJourneyService().plan({
      source: "Esplanade",
      destination: "Gariahat",
      mode: "BUS",
    });
    expect(journey.totalTimeMinutes).toBeGreaterThan(0);
  });
});

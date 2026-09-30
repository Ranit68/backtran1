import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config as loadDotenv } from "dotenv";

/**
 * Route connection tests, against the real database.
 *
 * Same reasoning as ferry.tram.integration.test.ts: api.contract.test.ts pins
 * DATABASE_URL to empty to assert the no-database behaviour, which is the wrong
 * place to prove that a platform number is read from a real row. So this file
 * loads .env itself, after removing the pinned value, because dotenv will not
 * overwrite a key that already exists in process.env.
 *
 * The platform assertions are deliberately written against what the data
 * actually says, including the parts that are contested. If someone corrects the
 * Esplanade conflict upstream, the conflict assertion below is expected to fail
 * loudly so the warning logic can be re-checked rather than silently left
 * testing a case that no longer exists.
 */

// Must happen before any import of env.ts, which snapshots whether a database is
// configured the first time it is evaluated.
delete process.env.DATABASE_URL;
loadDotenv();

const hasDatabase = Boolean(process.env.DATABASE_URL);

let app: import("fastify").FastifyInstance;
let closePool: typeof import("../src/config/database.js").closePool;
// Imported dynamically for the same reason the services are: a static import
// would be hoisted above loadDotenv() and would evaluate config/database.js
// while DATABASE_URL was still unset.
let stopNameCandidates: typeof import("../src/repositories/connections.repository.js").stopNameCandidates;

/** Response shape, kept loose so a field rename fails on use rather than on cast. */
interface ConnectionsBody {
  success: boolean;
  data: {
    route: { mode: string; routeNo: string; routeName: string | null };
    routeWindow: { firstDeparture: string | null; lastArrival: string | null } | null;
    metroLines: Array<{
      line: string;
      directions: Array<{
        direction: string;
        originStationName: string | null;
        destinationStationName: string | null;
        window: { firstDeparture: string | null; lastArrival: string | null };
      }>;
      platforms: Array<{
        stationCode: string;
        stationName: string;
        line: string;
        platformNumber: string;
        towards: string | null;
        verificationStatus: string;
        unverified: boolean;
      }>;
      platformWarning: string | null;
    }>;
    otherServices: Array<{ mode: string; routeId: string; window: { source: string } }>;
    matching: { matchedStations: number };
  };
}

async function get(url: string): Promise<{ status: number; body: ConnectionsBody }> {
  const res = await app.inject({ method: "GET", url });
  return { status: res.statusCode, body: res.json() as ConnectionsBody };
}

beforeAll(async () => {
  ({ stopNameCandidates } = await import("../src/repositories/connections.repository.js"));
  if (!hasDatabase) return;
  ({ closePool } = await import("../src/config/database.js"));
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  if (app) await app.close();
  if (closePool) await closePool();
});

// Pure function, so it runs with or without a database.
describe("stopNameCandidates", () => {
  it("yields the full name, the name without the bracket, and the bracket text", () => {
    expect(stopNameCandidates("Vivekananda Road (Girish Park)")).toEqual([
      "Vivekananda Road (Girish Park)",
      "Vivekananda Road",
      "Girish Park",
    ]);
  });

  it("returns only the name itself when there is no bracket", () => {
    expect(stopNameCandidates("Esplanade")).toEqual(["Esplanade"]);
  });

  it("does not return an empty candidate for a name that is only a bracket", () => {
    expect(stopNameCandidates("(Esplanade)")).not.toContain("");
  });
});

describe.skipIf(!hasDatabase)("GET /api/routes/:routeNo/connections", () => {
  it("returns a bus route's own window together with the lines it meets", async () => {
    // AC-4 is the one route in this data set that has stops, a timetable and a
    // metro station on its stop list, so it is the only bus route that can show
    // every part of the response at once.
    const { status, body } = await get("/api/routes/AC-4/connections?mode=BUS");

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.route.mode).toBe("BUS");
    expect(body.data.routeWindow?.firstDeparture).toMatch(/^\d{2}:\d{2}$/);
    expect(body.data.routeWindow?.lastArrival).toMatch(/^\d{2}:\d{2}$/);
    expect(body.data.matching.matchedStations).toBeGreaterThan(0);
    expect(body.data.metroLines.map((l) => l.line)).toContain("GREEN");
  });

  it("reports the first and last service in each direction for a metro line", async () => {
    const { status, body } = await get("/api/routes/GREEN/connections?mode=METRO");

    expect(status).toBe(200);
    const green = body.data.metroLines.find((l) => l.line === "GREEN");
    expect(green).toBeDefined();

    const down = green!.directions.find((d) => d.direction === "DOWN");
    const up = green!.directions.find((d) => d.direction === "UP");
    expect(down?.window.firstDeparture).toBe("06:09");
    expect(down?.window.lastArrival).toBe("23:02");
    expect(up?.window.firstDeparture).toBe("06:00");
    expect(up?.window.lastArrival).toBe("23:02");

    // Station names must not be run through the time formatter. This is a
    // regression guard: it once returned "Howra" instead of "Howrah Maidan".
    expect(down?.originStationName).toBe("Salt Lake Sector-V");
    expect(down?.destinationStationName).toBe("Howrah Maidan");
  });

  it("numbers platforms per line at a station, not per station", async () => {
    const { body } = await get("/api/routes/GREEN/connections?mode=METRO");
    const esplanade = body.data.metroLines
      .flatMap((l) => l.platforms)
      .filter((p) => p.stationName === "Esplanade");

    // KESP is on both Blue and Green, and each line carries its own P1 and P2.
    // The same two numbers appearing twice, once per line, is the whole point:
    // platform numbering is a property of a line at a station.
    expect(esplanade.length).toBe(4);
    expect(new Set(esplanade.map((p) => p.line))).toEqual(new Set(["BLUE", "GREEN"]));
    for (const line of ["BLUE", "GREEN"]) {
      const onLine = esplanade.filter((p) => p.line === line);
      expect(onLine.map((p) => p.platformNumber).sort()).toEqual(["1", "2"]);
    }
  });

  it("marks a contested platform number unverified and warns about it", async () => {
    const { body } = await get("/api/routes/GREEN/connections?mode=METRO");
    const esplanade = body.data.metroLines
      .flatMap((l) => l.platforms)
      .filter((p) => p.stationName === "Esplanade");

    // All four Esplanade rows are SOURCE_CONFLICT in this data set.
    expect(esplanade.length).toBeGreaterThan(0);
    for (const platform of esplanade) {
      expect(platform.verificationStatus).toBe("SOURCE_CONFLICT");
      expect(platform.unverified).toBe(true);
    }

    const warning = body.data.metroLines.find((l) => l.platformWarning)?.platformWarning;
    expect(warning).toMatch(/disagree/i);
    expect(warning).toMatch(/Esplanade/);
  });

  it("returns a platform number alongside its doubt, rather than hiding it", async () => {
    const { body } = await get("/api/routes/GREEN/connections?mode=METRO");
    const inferred = body.data.metroLines
      .flatMap((l) => l.platforms)
      .filter((p) => p.verificationStatus === "INFERRED_DIRECTION_PLATFORM");

    expect(inferred.length).toBeGreaterThan(0);
    for (const platform of inferred) {
      expect(platform.platformNumber).toMatch(/\d/);
      expect(platform.unverified).toBe(true);
    }
  });

  it("does not list a route as a connection to itself", async () => {
    const ferry = await get("/api/routes/F003/connections?mode=FERRY");
    expect(ferry.body.data.otherServices.map((s) => s.routeId)).not.toContain("F003");

    const tram = await get("/api/routes/TRAM5/connections?mode=TRAM");
    expect(tram.body.data.otherServices.map((s) => s.routeId)).not.toContain("TRAM5");
  });

  it("resolves a route number that contains a bracketed suffix", async () => {
    // "T-2 (Khidirpur)" is a real route number; the space must survive the URL.
    const { status, body } = await get("/api/routes/T-2%20(Khidirpur)/connections?mode=BUS");

    expect(status).toBe(200);
    expect(body.data.route.routeNo).toBe("T-2 (Khidirpur)");
  });

  it("answers 404 for a route number that does not exist", async () => {
    const { status } = await get("/api/routes/ZZZ-NOT-A-ROUTE/connections?mode=BUS");
    expect(status).toBe(404);
  });

  it("answers 200 with an empty list for a real route that meets no metro", async () => {
    // C-29 has stops but no metro station on its list. It exists, so 404 would
    // be a lie about the rider's route number.
    const { status, body } = await get("/api/routes/C-29/connections?mode=BUS");

    expect(status).toBe(200);
    expect(body.data.metroLines).toEqual([]);
    expect(body.data.otherServices).toEqual([]);
    expect(body.data.matching.matchedStations).toBe(0);
  });

  it("still reports a timetable for a route that has no stop list", async () => {
    // 11A is one of 65 route numbers present in bus_timetables but absent from
    // bus_route_stops. Its service window is the useful part of the answer.
    const { status, body } = await get("/api/routes/11A/connections?mode=BUS");

    expect(status).toBe(200);
    expect(body.data.routeWindow?.firstDeparture).toMatch(/^\d{2}:\d{2}$/);
    expect(body.data.metroLines).toEqual([]);
  });

  it("rejects a mode it does not know rather than guessing", async () => {
    const { status } = await get("/api/routes/GREEN/connections?mode=TELEPORT");
    expect(status).toBe(400);
  });

  it("reports no source for a service with no published times", async () => {
    // tram_services carries no first/last/frequency in this data set. The
    // endpoint must say so rather than inventing a window.
    const { body } = await get("/api/routes/GREEN/connections?mode=METRO");
    for (const service of body.data.otherServices) {
      if (service.mode === "TRAM") {
        expect(service.window.source).toBe("NONE");
      }
    }
  });
});

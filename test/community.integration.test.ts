import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config as loadDotenv } from "dotenv";

/**
 * Route-scoped community report tests, against the real database.
 *
 * Same reasoning as connections.integration.test.ts: api.contract.test.ts pins
 * DATABASE_URL to empty to assert the no-database behaviour, which is the wrong
 * place to prove that a post is scoped to the right route. So this file loads
 * .env itself, after removing the pinned value, because dotenv will not
 * overwrite a key that already exists in process.env.
 *
 * The tests that matter most are the scoping ones. "A post about the Blue Line
 * must not appear in the Green Line feed" is the entire premise of the feature,
 * and it is the kind of rule that can be broken by something innocent later, such
 * as someone grouping on the display label instead of the canonical key. So the
 * alias test below posts using the label and reads using the identifier, and
 * expects one feed, not two.
 */

// Must happen before any import of env.ts, which snapshots the environment the
// first time it is evaluated.
delete process.env.DATABASE_URL;
loadDotenv();

// app.js reads the community write limit when it builds the route table, and
// inject() sends every request from the same loopback address. Without raising
// it here, the production default of 5 per 10 minutes would make the suite fail
// on 429s that say nothing about the code under test.
process.env.COMMUNITY_POST_RATE_LIMIT_MAX = "1000";

// Set so the admin sweep below can be exercised through the real guard rather
// than being asserted as permanently unreachable. api.contract.test.ts covers
// the unset case, which is where "fails closed" actually lives.
process.env.ADMIN_KEY = "community-test-key";

const hasDatabase = Boolean(process.env.DATABASE_URL);

let app: import("fastify").FastifyInstance;
let closePool: typeof import("../src/config/database.js").closePool;
let normaliseMessage: typeof import("../src/repositories/community.repository.js").normaliseMessage;
let createReport: typeof import("../src/repositories/community.repository.js").createReport;
let listReports: typeof import("../src/repositories/community.repository.js").listReports;
let resolveRouteScope: typeof import("../src/repositories/community.repository.js").resolveRouteScope;
let sweepExpired: typeof import("../src/repositories/community.repository.js").sweepExpired;
let query: typeof import("../src/config/database.js").query;

interface ReportBody {
  reportId: string;
  mode: string;
  routeKey: string;
  routeLabel: string;
  message: string;
  createdAt: string;
  expiresAt: string;
  anonymous: true;
  expiresInHours: number;
}

interface FeedBody {
  scope: { mode: string; key: string; label: string };
  reports: ReportBody[];
  totalActive: number;
  offset: number;
  hasMore: boolean;
  ttlHours: number;
  messageMaxLength: number;
  posting: { anonymous: true; requiresAccount: false };
}

interface Envelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

async function get<T>(url: string): Promise<{ status: number; body: Envelope<T> }> {
  const res = await app.inject({ method: "GET", url });
  return { status: res.statusCode, body: res.json() as Envelope<T> };
}

async function post<T>(
  url: string,
  payload: unknown,
): Promise<{ status: number; body: Envelope<T> }> {
  const res = await app.inject({ method: "POST", url, payload: payload as object });
  return { status: res.statusCode, body: res.json() as Envelope<T> };
}

const HOUR_MS = 3_600_000;

beforeAll(async () => {
  const repo = await import("../src/repositories/community.repository.js");
  ({ normaliseMessage, createReport, listReports, resolveRouteScope, sweepExpired } = repo);
  if (!hasDatabase) return;
  const db = await import("../src/config/database.js");
  ({ closePool, query } = db);
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
  // Start from a known-empty table. The sweep below only ever removes rows that
  // are already expired, so a leftover live post from an earlier run would
  // otherwise leak into the count assertions.
  await query("DELETE FROM community_reports");
});

afterAll(async () => {
  if (app) {
    if (query) await query("DELETE FROM community_reports");
    await app.close();
  }
  if (closePool) await closePool();
});

// Pure, so it runs with or without a database.
describe("normaliseMessage", () => {
  it("trims and collapses runs of whitespace so a post is one block of text", () => {
    expect(normaliseMessage("  water   logging\n\nat   Esplanade  ")).toBe(
      "water logging at Esplanade",
    );
  });

  it("replaces control characters with a space instead of dropping text", () => {
    // A terminal paste can carry a zero-width or escape character. Removing them
    // outright would silently join two words together ("a<0x07>b" -> "ab"),
    // which reads as a typo the poster never made.
    expect(normaliseMessage("traffic\u0000jam")).toBe("traffic jam");
    expect(normaliseMessage("a\u0007b")).toBe("a b");
  });

  it("reduces a whitespace-only message to the empty string, so it can be rejected", () => {
    expect(normaliseMessage("   \n\t  ")).toBe("");
  });

  it("leaves angle brackets alone: this is plain text, never HTML", () => {
    // Escaping here would mean the client has to unescape, which is how double
    // escaping bugs start. The text is rendered as text, so it is left as typed.
    expect(normaliseMessage("bridge down <-- use detour")).toBe("bridge down <-- use detour");
  });
});

describe.skipIf(!hasDatabase)("resolveRouteScope", () => {
  it("maps a metro identifier to its line, and the label to the same key", async () => {
    // The pairing matters more than either result: posting by label and reading
    // by identifier must land in one community.
    const byId = await resolveRouteScope("METRO", "BLUE");
    const byLabel = await resolveRouteScope("METRO", "North-South / Blue Line");
    const bySuffix = await resolveRouteScope("METRO", "Blue Line");
    expect(byId).not.toBeNull();
    expect(byLabel?.key).toBe(byId!.key);
    expect(bySuffix?.key).toBe(byId!.key);
    expect(byId!.label).toBe("North-South / Blue Line");
  });

  it("is case-insensitive, because riders type 'blue'", async () => {
    expect((await resolveRouteScope("METRO", "blue"))?.key).toBe("BLUE");
  });

  it("resolves a line that has no timetable, since a community does not need one", async () => {
    // PINK is in metro_routes with no timetable PDF. Excluding it would silently
    // deny the line a place to talk about its own service.
    expect((await resolveRouteScope("METRO", "PINK"))?.key).toBe("PINK");
  });

  it("keeps different lines apart", async () => {
    expect((await resolveRouteScope("METRO", "GREEN"))?.key).toBe("GREEN");
    expect((await resolveRouteScope("METRO", "BLUE"))?.key).not.toBe("GREEN");
  });

  it("resolves a bus route number to itself", async () => {
    expect((await resolveRouteScope("BUS", "AC-4"))?.key).toBe("AC-4");
    expect((await resolveRouteScope("BUS", "ac-4"))?.key).toBe("AC-4");
  });

  it("describes a bus route with its depot without stuttering the word", async () => {
    // There is no bus_routes table, so the depot is the only description
    // available. The label must lead with the route number, because that is the
    // identity a rider recognises, and must not append "depot" to a name that
    // already ends in "Depot".
    const scope = await resolveRouteScope("BUS", "AC-4");
    expect(scope!.label).toContain("AC-4");
    expect(scope!.label.toLowerCase()).not.toContain("depot depot");
    expect(scope!.label).toBe("AC-4 · Barasat Depot");
  });

  it("resolves a ferry route by id and by name to one key", async () => {
    const byId = await resolveRouteScope("FERRY", "F003");
    expect(byId).not.toBeNull();
    const byName = await resolveRouteScope("FERRY", byId!.label);
    expect(byName?.key).toBe(byId!.key);
  });

  it("resolves a tram route by id, by number and by name to one key", async () => {
    // A rider should not have to know which of the three the community expects.
    const byId = await resolveRouteScope("TRAM", "TRAM5");
    expect(byId).not.toBeNull();
    const { queryOne } = await import("../src/config/database.js");
    const row = await queryOne<{ route_no: string; route_name: string }>(
      `SELECT route_no, route_name FROM tram_routes WHERE UPPER(TRIM(route_id)) = 'TRAM5'`,
    );
    expect(row).not.toBeNull();
    expect((await resolveRouteScope("TRAM", row!.route_no))?.key).toBe(byId!.key);
    expect((await resolveRouteScope("TRAM", row!.route_name))?.key).toBe(byId!.key);
  });

  it("returns null for a route that does not exist", async () => {
    expect(await resolveRouteScope("METRO", "CHARTREUSE")).toBeNull();
    expect(await resolveRouteScope("BUS", "NOT-A-ROUTE")).toBeNull();
    expect(await resolveRouteScope("FERRY", "F999")).toBeNull();
    expect(await resolveRouteScope("TRAM", "TRAM999")).toBeNull();
  });

  it("returns null for blank input rather than matching everything", async () => {
    expect(await resolveRouteScope("METRO", "   ")).toBeNull();
  });
});

describe.skipIf(!hasDatabase)("POST /api/community/:mode/:route", () => {
  it("creates a report and states the rules that govern it", async () => {
    const { status, body } = await post<ReportBody>("/api/community/METRO/BLUE", {
      message: "Heavy traffic near Dum Dum, buses are 20 minutes late.",
    });

    expect(status).toBe(201);
    expect(body.success).toBe(true);
    const report = body.data!;
    expect(report.message).toBe("Heavy traffic near Dum Dum, buses are 20 minutes late.");
    // Anonymous is asserted because it is a promise the API makes to riders, not
    // an omission: nothing in this service can verify who wrote a post.
    expect(report.anonymous).toBe(true);
    expect(report.routeKey).toBe("BLUE");
    expect(report.routeLabel).toBe("North-South / Blue Line");
    expect(report.mode).toBe("METRO");

    const created = Date.parse(report.createdAt);
    const expires = Date.parse(report.expiresAt);
    expect(Number.isNaN(created)).toBe(false);
    expect(expires - created).toBe(24 * HOUR_MS);
    // Floored countdown, so it reads 23 or 24 immediately after posting and
    // never goes negative once the post has expired.
    expect([23, 24]).toContain(report.expiresInHours);
  });

  it("scopes the post to the route that was asked for, and to no other", async () => {
    await post("/api/community/METRO/GREEN", { message: "Green Line running normally." });

    const blue = await get<FeedBody>("/api/community/METRO/BLUE");
    const green = await get<FeedBody>("/api/community/METRO/GREEN");

    const blueMessages = blue.body.data!.reports.map((r) => r.message);
    const greenMessages = green.body.data!.reports.map((r) => r.message);

    expect(blueMessages).toContain("Heavy traffic near Dum Dum, buses are 20 minutes late.");
    expect(greenMessages).toContain("Green Line running normally.");
    // The premise of the whole feature, asserted directly.
    expect(greenMessages).not.toContain("Heavy traffic near Dum Dum, buses are 20 minutes late.");
    expect(blueMessages).not.toContain("Green Line running normally.");
  });

  it("keeps the same mode apart, so a bus and a metro route number cannot collide", async () => {
    // METRO/GREEN and BUS/AC-4 are unrelated, but the real hazard is two modes
    // sharing a key, so the feed query is written to require both columns.
    const metro = await get<FeedBody>("/api/community/METRO/GREEN");
    const bus = await get<FeedBody>("/api/community/BUS/AC-4");
    expect(metro.body.data!.scope).toEqual({
      mode: "METRO",
      key: "GREEN",
      label: "East-West / Green Line",
    });
    expect(bus.body.data!.scope.key).toBe("AC-4");
  });

  it("accepts the route by label and still files it under the canonical key", async () => {
    await post("/api/community/METRO/North-South%20%2F%20Blue%20Line", {
      message: "Posted using the full line name.",
    });

    const byId = await get<FeedBody>("/api/community/METRO/BLUE");
    const byLabel = await get<FeedBody>("/api/community/METRO/North-South%20%2F%20Blue%20Line");

    // One community, not two: this is the case that breaks if grouping ever moves
    // from the canonical key to the display label.
    const messages = byId.body.data!.reports.map((r) => r.message);
    expect(messages).toContain("Posted using the full line name.");
    expect(byLabel.body.data!.reports.map((r) => r.message)).toEqual(messages);
    expect(byId.body.data!.totalActive).toBe(byLabel.body.data!.totalActive);
  });

  it("normalises whitespace before storing, so the feed stays one block per post", async () => {
    await post("/api/community/METRO/BLUE", { message: "  flooded   underpass\n\n  avoid  " });
    const feed = await get<FeedBody>("/api/community/METRO/BLUE");
    expect(feed.body.data!.reports.map((r) => r.message)).toContain("flooded underpass avoid");
  });

  it("rejects an empty message", async () => {
    const { status, body } = await post("/api/community/METRO/BLUE", { message: "" });
    expect(status).toBe(400);
    expect(body.error?.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a whitespace-only message, which passes a plain length check", async () => {
    // The one validation that cannot live in the database CHECK: char_length('   ')
    // is 3, so the table is happy to store it and only the controller can tell
    // that there is no actual content.
    const { status, body } = await post("/api/community/METRO/BLUE", { message: "   \n\t " });
    expect(status).toBe(400);
    expect(body.error?.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a missing message", async () => {
    const { status, body } = await post("/api/community/METRO/BLUE", {});
    expect(status).toBe(400);
    expect(body.error?.code).toBe("VALIDATION_ERROR");
  });

  it("accepts exactly 500 characters and rejects 501", async () => {
    const atLimit = await post("/api/community/METRO/BLUE", { message: "a".repeat(500) });
    expect(atLimit.status).toBe(201);

    const overLimit = await post("/api/community/METRO/BLUE", { message: "a".repeat(501) });
    expect(overLimit.status).toBe(400);
    expect(overLimit.body.error?.code).toBe("VALIDATION_ERROR");
  });

  it("refuses a route that does not exist, rather than storing an invisible post", async () => {
    // Accepting it would be silent data loss: the feed can only ever be fetched
    // by a real route, so the post could never be read by anyone, ever.
    const { status, body } = await post("/api/community/METRO/CHARTREUSE", { message: "hello" });
    expect(status).toBe(404);
    expect(body.error?.code).toBe("ROUTE_NOT_FOUND");
  });

  it("rejects an unknown mode", async () => {
    const { status, body } = await post("/api/community/CABLECAR/BLUE", { message: "hello" });
    expect(status).toBe(400);
    expect(body.error?.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a message that is not a string, rather than coercing it", async () => {
    // Without a type check, a number or an array would be stringified somewhere
    // in the stack and end up stored as a post nobody can read.
    expect((await post("/api/community/METRO/BLUE", { message: 42 })).status).toBe(400);
    expect((await post("/api/community/METRO/BLUE", { message: ["a", "b"] })).status).toBe(400);
    expect((await post("/api/community/METRO/BLUE", { message: { text: "hi" } })).status).toBe(400);
    expect((await post("/api/community/METRO/BLUE", { message: null })).status).toBe(400);
  });
});

describe.skipIf(!hasDatabase)("GET /api/community/:mode/:route", () => {
  it("returns the feed with the rules restated, so a client cannot hardcode them", async () => {
    await query("DELETE FROM community_reports");
    const { status, body } = await get<FeedBody>("/api/community/FERRY/F003");

    expect(status).toBe(200);
    const feed = body.data!;
    expect(feed.reports).toEqual([]);
    expect(feed.totalActive).toBe(0);
    expect(feed.hasMore).toBe(false);
    expect(feed.ttlHours).toBe(24);
    expect(feed.messageMaxLength).toBe(500);
    expect(feed.posting).toEqual({ anonymous: true, requiresAccount: false });
  });

  it("orders newest first", async () => {
    await query("DELETE FROM community_reports");
    const scope = await resolveRouteScope("METRO", "PURPLE");
    await createReport(scope!, "older report");
    // created_at is the sort key, so an explicit second is needed to make the
    // ordering deterministic rather than dependent on clock resolution.
    await query(
      `UPDATE community_reports SET created_at = NOW() - INTERVAL '2 minutes',
         expires_at = NOW() + INTERVAL '22 hours' WHERE message = 'older report'`,
    );
    await createReport(scope!, "newer report");

    const feed = await listReports(scope!, 50);
    expect(feed.reports.map((r) => r.message)).toEqual(["newer report", "older report"]);
  });

  it("paginates and says whether more exist", async () => {
    await query("DELETE FROM community_reports");
    const scope = await resolveRouteScope("METRO", "YELLOW");
    for (let i = 0; i < 5; i++) await createReport(scope!, `report ${i}`);

    const page = await listReports(scope!, 2);
    expect(page.reports).toHaveLength(2);
    expect(page.totalActive).toBe(5);
    expect(page.hasMore).toBe(true);

    const everything = await listReports(scope!, 50);
    expect(everything.reports).toHaveLength(5);
    expect(everything.hasMore).toBe(false);
  });

  it("pages through the whole feed with offset, without repeating a post", async () => {
    // The whole point of offset is that a caller can reach posts a single page
    // cannot hold. A feed that silently drops everything past the first window
    // would still pass a test that only reads page one.
    await query("DELETE FROM community_reports");
    const scope = await resolveRouteScope("METRO", "YELLOW");
    for (let i = 0; i < 5; i++) await createReport(scope!, `paged report ${i}`);

    const seen: string[] = [];
    let offset = 0;
    for (let page = 0; page < 10; page++) {
      const { status, body } = await get<FeedBody>(
        `/api/community/METRO/YELLOW?limit=2&offset=${offset}`,
      );
      expect(status).toBe(200);
      const feed = body.data!;
      // Echoed back so the caller does not have to recompute where it was.
      expect(feed.offset).toBe(offset);
      expect(feed.totalActive).toBe(5);
      seen.push(...feed.reports.map((r) => r.message));
      if (!feed.hasMore) break;
      offset += feed.reports.length;
    }

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it("stops claiming there is more once the reader is past the end", async () => {
    // An empty window and a feed with nothing left in it must not be the same
    // answer. Judged only against page length, an offset past the end reads as
    // "hasMore: true" forever, which sends a client looping on a feed that will
    // never grow.
    await query("DELETE FROM community_reports");
    const scope = await resolveRouteScope("METRO", "YELLOW");
    for (let i = 0; i < 3; i++) await createReport(scope!, `tail report ${i}`);

    const { status, body } = await get<FeedBody>(
      "/api/community/METRO/YELLOW?limit=2&offset=100",
    );
    expect(status).toBe(200);
    const feed = body.data!;
    expect(feed.reports).toEqual([]);
    expect(feed.offset).toBe(100);
    expect(feed.totalActive).toBe(3);
    expect(feed.hasMore).toBe(false);
  });

  it("rejects an offset that is negative or not a number", async () => {
    expect((await get("/api/community/METRO/BLUE?offset=-1")).status).toBe(400);
    expect((await get("/api/community/METRO/BLUE?offset=abc")).status).toBe(400);
    expect((await get("/api/community/METRO/BLUE?offset=1.5")).status).toBe(400);
  });

  it("404s an unknown route instead of returning an empty feed", async () => {
    // An empty 200 would be indistinguishable from "nothing is happening",
    // which is exactly the message a rider must never be given by mistake.
    const { status, body } = await get("/api/community/BUS/NOT-A-ROUTE");
    expect(status).toBe(404);
    expect(body.error?.code).toBe("ROUTE_NOT_FOUND");
  });

  it("rejects an unknown mode and an out-of-range limit", async () => {
    expect((await get("/api/community/CABLECAR/BLUE")).status).toBe(400);
    expect((await get("/api/community/METRO/BLUE?limit=0")).status).toBe(400);
    expect((await get("/api/community/METRO/BLUE?limit=101")).status).toBe(400);
    expect((await get("/api/community/METRO/BLUE?limit=notanumber")).status).toBe(400);
  });
});

describe.skipIf(!hasDatabase)("24 hour lifetime", () => {
  it("hides an expired post immediately, without waiting for any cleanup", async () => {
    await query("DELETE FROM community_reports");
    const scope = await resolveRouteScope("METRO", "BLUE");
    await query(
      `INSERT INTO community_reports
         (report_id, scope_mode, scope_key, scope_label, message, created_at, expires_at)
       VALUES ('t_expired', 'METRO', 'BLUE', $1, 'an old report',
               NOW() - INTERVAL '25 hours', NOW() - INTERVAL '1 hour')`,
      [scope!.label],
    );

    // Read before any sweep: the post is already gone from the feed. Correctness
    // does not depend on the cleanup job, which is the property that matters.
    const feed = await listReports(scope!, 50);
    expect(feed.reports.map((r) => r.message)).not.toContain("an old report");
    expect(feed.totalActive).toBe(0);
  });

  it("keeps a post that is still inside its 24 hours", async () => {
    await query("DELETE FROM community_reports");
    const scope = await resolveRouteScope("METRO", "BLUE");
    // One minute left: still live. Proving the boundary matters, because a test
    // that only checks "23 hours old is hidden" would also pass if the rule were
    // 23 hours instead of 24.
    await query(
      `INSERT INTO community_reports
         (report_id, scope_mode, scope_key, scope_label, message, created_at, expires_at)
       VALUES ('t_live', 'METRO', 'BLUE', $1, 'a nearly old report',
               NOW() - INTERVAL '23 hours 59 minutes', NOW() + INTERVAL '1 minute')`,
      [scope!.label],
    );

    const feed = await listReports(scope!, 50);
    expect(feed.reports.map((r) => r.message)).toContain("a nearly old report");
    expect(feed.reports[0]!.expiresInHours).toBe(0);
  });

  it("reclaims the space of expired posts on a sweep, and leaves live ones alone", async () => {
    await query("DELETE FROM community_reports");
    const scope = await resolveRouteScope("METRO", "BLUE");
    await createReport(scope!, "still live");
    await query(
      `INSERT INTO community_reports
         (report_id, scope_mode, scope_key, scope_label, message, created_at, expires_at)
       VALUES ('t_sweep', 'METRO', 'BLUE', $1, 'expired', NOW() - INTERVAL '30 hours',
               NOW() - INTERVAL '6 hours')`,
      [scope!.label],
    );

    expect(await sweepExpired()).toBeGreaterThanOrEqual(1);

    const remaining = await query<{ message: string }>(
      `SELECT message FROM community_reports WHERE scope_mode='METRO' AND scope_key='BLUE'`,
    );
    expect(remaining.map((r) => r.message)).toEqual(["still live"]);
  });

  it("expires a post created through the API after exactly 24 hours", async () => {
    await query("DELETE FROM community_reports");
    await post("/api/community/METRO/ORANGE", { message: "Orange Line update." });

    const hours = await query<{ hours: string }>(
      `SELECT (EXTRACT(EPOCH FROM (expires_at - created_at)) / 3600)::numeric(10, 2) AS hours
         FROM community_reports WHERE message = 'Orange Line update.'`,
    );
    // Read back from storage rather than trusting the controller's own arithmetic,
    // so this proves what was actually written to the row.
    expect(Number(hours[0]!.hours)).toBe(24);
  });
});

describe.skipIf(!hasDatabase)("POST /api/admin/community/sweep", () => {
  async function sweep(headers: Record<string, string> = {}) {
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/community/sweep",
      headers,
    });
    return { status: res.statusCode, body: res.json() as Envelope<{ removed: number }> };
  }

  it("refuses a request with no key or the wrong key", async () => {
    // The guard is the same one the graph rebuild uses, so the failure shape is
    // already pinned by api.contract.test.ts; this only proves the new route is
    // behind it rather than accidentally open.
    expect((await sweep()).status).toBe(401);
    expect((await sweep({ "x-admin-key": "wrong" })).status).toBe(401);
  });

  it("removes expired reports on demand and counts them, leaving live ones", async () => {
    await query("DELETE FROM community_reports");
    const scope = await resolveRouteScope("METRO", "GREEN");
    await createReport(scope!, "keep me past the sweep");
    await query(
      `INSERT INTO community_reports
         (report_id, scope_mode, scope_key, scope_label, message, created_at, expires_at)
       VALUES ('t_sweep_endpoint', 'METRO', 'GREEN', $1, 'already gone',
               NOW() - INTERVAL '30 hours', NOW() - INTERVAL '6 hours')`,
      [scope!.label],
    );

    const { status, body } = await sweep({ "x-admin-key": process.env.ADMIN_KEY! });
    expect(status).toBe(200);
    // Greater than rather than equal: the sweep is global, so it may also
    // reclaim rows other tests left expired.
    expect(body.data!.removed).toBeGreaterThanOrEqual(1);

    // The count alone would not catch a sweep that deleted live posts too.
    const feed = await listReports(scope!, 50);
    expect(feed.reports.map((r) => r.message)).toEqual(["keep me past the sweep"]);
  });
});

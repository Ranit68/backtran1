import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { closePool } from "../src/config/database.js";

/**
 * HTTP contract tests.
 *
 * These run with NO DATABASE_URL, which is the whole point: the app must boot,
 * answer, and fail with the documented envelope instead of crashing. The
 * database-backed paths are verified separately once a Supabase project exists.
 */

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await closePool();
});

describe("GET /api/health", () => {
  it("returns 200 and reports every active mode, even with no database", async () => {
    const response = await app.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.success).toBe(true);
    expect(body.data.status).toBe("ok");
    expect(body.data.components.database.configured).toBe(false);
    expect(body.data.modes.BUS.implemented).toBe(true);
    expect(body.data.modes.METRO.implemented).toBe(true);
    // Present as an implemented endpoint, but with no database it has no data
    // behind it, which the flag states rather than implies.
    expect(body.data.modes.METRO.configured).toBe(false);
    expect(body.data.modes.FERRY.implemented).toBe(false);
  });

  it("reports Tram as retired rather than implemented", async () => {
    const response = await app.inject({ method: "GET", url: "/api/health" });

    const body = response.json();
    expect(body.data.modes.TRAM).toBeUndefined();
    expect(body.data.retiredModes.TRAM).toBeTypeOf("string");
  });
});

describe("retired Tram surface", () => {
  it("answers every old endpoint with 410 rather than 404", async () => {
    for (const url of [
      "/api/tram/routes",
      "/api/tram/routes/26",
      "/api/tram/routes/26/stops",
      "/api/tram/search?q=esplanade",
      "/api/tram/anything/else",
    ]) {
      const response = await app.inject({ method: "GET", url });

      expect(response.statusCode, url).toBe(410);
      const body = response.json();
      expect(body.success, url).toBe(false);
      expect(body.error.code, url).toBe("TRAM_SERVICE_WITHDRAWN");
    }
  });

  it("answers non-GET methods on the same wildcard", async () => {
    const response = await app.inject({ method: "POST", url: "/api/tram/routes" });

    expect(response.statusCode).toBe(410);
    expect(response.json().error.code).toBe("TRAM_SERVICE_WITHDRAWN");
  });
});

describe("error envelope", () => {
  it("uses the standard failure shape for an unknown route", async () => {
    const response = await app.inject({ method: "GET", url: "/api/does-not-exist" });

    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("NOT_FOUND");
    expect(typeof body.error.message).toBe("string");
  });

  it("reports a missing database rather than crashing on a data endpoint", async () => {
    const response = await app.inject({ method: "GET", url: "/api/bus/routes" });

    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("DATABASE_NOT_CONFIGURED");
  });
});

describe("request validation", () => {
  it("rejects a blank search term with field-level detail", async () => {
    const response = await app.inject({ method: "GET", url: "/api/search?q=" });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(JSON.stringify(body.error.details)).toContain("q");
  });

  it("rejects a journey with identical source and destination", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/journey",
      payload: { source: "Park Street", destination: "Park Street" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a missing required journey field", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/journey",
      payload: { source: "Park Street" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects malformed JSON as INVALID_JSON, not INTERNAL_ERROR", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/journey",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_JSON");
  });

  it("rejects an out-of-range page size", async () => {
    const response = await app.inject({ method: "GET", url: "/api/bus/routes?limit=99999" });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
  });
});

describe("Metro and Ferry", () => {
  it("reports the missing database on a Metro data endpoint, not an empty list", async () => {
    const response = await app.inject({ method: "GET", url: "/api/metro/stations" });

    // 503 rather than 501: the endpoint is implemented and the tables are
    // expected, so the fault is the missing DATABASE_URL, not a missing mode.
    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.error.code).toBe("DATABASE_NOT_CONFIGURED");
  });

  it("returns 200 from the Metro status route so a client can explain itself", async () => {
    const response = await app.inject({ method: "GET", url: "/api/metro/status" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.implemented).toBe(true);
    expect(body.data.configured).toBe(false);
    expect(body.data.requiredTables).toContain("metro_timetable_checkpoints");
  });

  it("returns 501 for a Ferry endpoint", async () => {
    const response = await app.inject({ method: "GET", url: "/api/ferry/routes" });
    expect(response.statusCode).toBe(501);
    expect(response.json().error.code).toBe("FERRY_NOT_CONFIGURED");
  });
});

describe("admin routes", () => {
  it("fails closed when ADMIN_KEY is unset", async () => {
    const response = await app.inject({ method: "POST", url: "/api/admin/graph/refresh" });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("ADMIN_AUTH_REQUIRED");
  });

  it("leaves the status route open so an operator can see whether admin is enabled", async () => {
    const response = await app.inject({ method: "GET", url: "/api/admin/status" });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.enabled).toBe(false);
  });
});

describe("service index", () => {
  it("lists the endpoints under /api for a quick manual check", async () => {
    const response = await app.inject({ method: "GET", url: "/api" });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.endpoints.journey).toBe("POST /api/journey");
  });
});

describe("frontend", () => {
  it("serves the single-page app at the root", async () => {
    const response = await app.inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("<!doctype html>");
  });

  it("serves the app for a deep link so client routing works on reload", async () => {
    const response = await app.inject({ method: "GET", url: "/plan" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("<!doctype html>");
  });

  it("does not let the frontend shadow a missing API endpoint", async () => {
    const response = await app.inject({ method: "GET", url: "/api/does-not-exist" });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
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

    // Still 200: a health check that goes 5xx gets the deployment killed.
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.success).toBe(true);
    // "degraded" rather than "ok" because there is no database and so nothing can
    // be routed. The status field is allowed to be unhappy; the HTTP code is not.
    expect(body.data.status).toBe("degraded");
    expect(body.data.components.database.configured).toBe(false);
    expect(body.data.modes.BUS.implemented).toBe(true);
    expect(body.data.modes.METRO.implemented).toBe(true);
    // Present as an implemented endpoint, but with no database it has no data
    // behind it, which the flag states rather than implies.
    expect(body.data.modes.METRO.configured).toBe(false);
  });

  it("reports Ferry and Tram as implemented modes, not reserved ones", async () => {
    const response = await app.inject({ method: "GET", url: "/api/health" });

    const body = response.json();
    expect(body.data.modes.FERRY.implemented).toBe(true);
    expect(body.data.modes.TRAM.implemented).toBe(true);
    // Neither is a live data source without a database, and the health payload
    // says so rather than implying otherwise.
    expect(body.data.modes.FERRY.configured).toBe(false);
    expect(body.data.modes.TRAM.configured).toBe(false);
  });

  it("no longer reports Tram under retiredModes", async () => {
    const response = await app.inject({ method: "GET", url: "/api/health" });

    const body = response.json();
    // The tram network is in operation, so there is no retired-mode entry for it.
    expect(body.data.retiredModes?.TRAM).toBeUndefined();
  });
});

describe("live Tram surface", () => {
  it("routes every documented endpoint to a data layer instead of a 410 stub", async () => {
    for (const url of [
      "/api/tram/routes",
      "/api/tram/routes/5",
      "/api/tram/routes/5/stops",
      "/api/tram/routes/TRAM25/legs",
      "/api/tram/search?q=esplanade",
      "/api/ferry/routes",
      "/api/ferry/ghats",
    ]) {
      const response = await app.inject({ method: "GET", url });

      // 503 is the documented answer with no DATABASE_URL. The point of these
      // assertions is that the status is NOT 410: the endpoints are real, and the
      // only thing missing is the database.
      expect(response.statusCode, url).not.toBe(410);
      expect(response.statusCode, url).not.toBe(501);
      expect(response.statusCode, url).toBe(503);
      const body = response.json();
      expect(body.success, url).toBe(false);
      expect(body.error.code, url).toBe("DATABASE_NOT_CONFIGURED");
    }
  });

  it("serves the Tram status route so a client can explain itself without data", async () => {
    const response = await app.inject({ method: "GET", url: "/api/tram/status" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.implemented).toBe(true);
    expect(body.data.configured).toBe(false);
  });

  it("answers an unknown Tram path with 404 rather than 410", async () => {
    const response = await app.inject({ method: "GET", url: "/api/tram/anything/else" });

    // There is no wildcard route any more: the surface is an ordinary router, so
    // a path that does not exist is genuinely not found.
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
  });

  it("answers a non-GET method on a GET-only Tram path with 404", async () => {
    const response = await app.inject({ method: "POST", url: "/api/tram/routes" });

    expect(response.statusCode).toBe(404);
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

  it("reports a throttle as RATE_LIMITED, not as a validation failure", async () => {
    // The community write limiter is the only per-route limit in the app, so it
    // is what this exercises. The first five posts get through the limiter and
    // then fail on the missing database, which is itself worth asserting: the
    // limiter runs before the handler, so an unauthenticated caller cannot use
    // a broken database to get unlimited writes. It also proves the community
    // repository honours the no-database contract, since that 503 comes from
    // requireDatabase() rather than from a caught driver error.
    const url = "/api/community/METRO/BLUE";
    const payload = { message: "rate limit contract check" };
    const statuses: number[] = [];
    let last: { success: boolean; error: { code: string } } | null = null;

    for (let i = 0; i < 6; i++) {
      const response = await app.inject({ method: "POST", url, payload });
      statuses.push(response.statusCode);
      last = response.json();
    }

    expect(statuses.slice(0, 5)).toEqual([503, 503, 503, 503, 503]);
    expect(statuses[5]).toBe(429);
    // A client told VALIDATION_ERROR would treat the request as malformed and
    // give up; RATE_LIMITED tells it to back off and try again.
    expect(last!.success).toBe(false);
    expect(last!.error.code).toBe("RATE_LIMITED");
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

  it("treats a Ferry data endpoint as implemented, not as a missing mode", async () => {
    const response = await app.inject({ method: "GET", url: "/api/ferry/routes" });

    // 503 rather than 501: the ferry data set is loaded and the endpoints are
    // implemented, so with no DATABASE_URL the fault is the missing connection.
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("DATABASE_NOT_CONFIGURED");
  });

  it("serves the Ferry status route so a client can explain itself without data", async () => {
    const response = await app.inject({ method: "GET", url: "/api/ferry/status" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.implemented).toBe(true);
    expect(body.data.configured).toBe(false);
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

/**
 * Deployment config contract.
 *
 * The tests above already prove the app serves the frontend for any non-API
 * path. That is not the same as proving the browser ever asks it to, because on
 * Vercel that request has to survive a routing decision made in vercel.json
 * before any code runs. When the only rewrite covered /api/*, / was answered by
 * Vercel itself and every page load 500ed while the entire app test suite stayed
 * green. The regression was invisible from inside the repo, so the config is
 * asserted here where a change to it has to break something.
 */
describe("vercel.json routing", () => {
  const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")) as {
    buildCommand?: string | null;
    functions?: Record<string, { includeFiles?: string[] }>;
    rewrites?: { source: string; destination: string }[];
  };
  const rewrites = config.rewrites ?? [];
  const entryPoint = "api/index.ts";

  it("does not run the TypeScript build on Vercel", () => {
    // tsconfig.build.json pins rootDir to src, so `npm run build` emits only
    // dist/** and never api/index.ts. Handing Vercel a build command switches it
    // from bundling the api/ directory out of source to treating the build
    // output as the whole deployment, after which functions.api/index.ts and
    // every rewrite pointing at it refer to a path that does not exist and the
    // build fails. The api/ entry imports ../src/app.js, so it needs no build
    // step at all; dist/ is only for `npm start` locally.
    expect(config.buildCommand).toBeNull();
  });

  it("keeps the entry point out of the TypeScript build output", () => {
    // Guards the reason the build command is disabled. If api/ is ever added to
    // tsconfig.build.json, the compiled entry could be used instead and the null
    // above would be a workaround for a build that is no longer broken.
    const buildConfig = JSON.parse(
      readFileSync(new URL("../tsconfig.build.json", import.meta.url), "utf8")
    ) as { include?: string[]; compilerOptions?: { rootDir?: string } };
    expect(buildConfig.include ?? []).not.toContain("api/**/*.ts");
    expect(buildConfig.compilerOptions?.rootDir).toBe("src");
  });

  it("routes the root to the serverless entry point", () => {
    // Without this the deployed site 500s on every page load, which is the
    // failure this file exists to prevent.
    expect(rewrites.map((r) => r.source)).toContain("/");
  });

  it("routes deep links to the entry point so a reload lands on the app", () => {
    expect(rewrites.map((r) => r.source)).toContain("/:path*");
  });

  it("sends every rewrite to the single function", () => {
    // Two entry points would mean two copies of the cached Fastify instance and
    // two separate Postgres pools.
    for (const rewrite of rewrites) {
      expect(rewrite.destination).toBe(`/${entryPoint}`);
    }
  });

  it("matches API paths before the catch-all", () => {
    // Vercel applies the first matching rewrite and only the first, so the
    // catch-all has to come last. If it were first it would swallow /api/* and
    // route API calls through the frontend fallback.
    const apiIndex = rewrites.findIndex((r) => r.source.startsWith("/api"));
    const catchAllIndex = rewrites.findIndex((r) => r.source === "/:path*");
    expect(apiIndex).toBeGreaterThanOrEqual(0);
    expect(catchAllIndex).toBeGreaterThanOrEqual(0);
    expect(apiIndex).toBeLessThan(catchAllIndex);
  });

  it("bundles the frontend into the function, since the host serves no files", () => {
    // public/index.html is read at runtime by src/frontend.ts, so if it is not
    // included in the bundle the entry point 500s on every page request.
    const include = config.functions?.[entryPoint]?.includeFiles ?? [];
    expect(include).toContain("public/**");
  });
});

import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { ZodError } from "zod";
import { env } from "./config/env.js";
import { AppError, ErrorCode } from "./utils/errors.js";
import { sendFail, sendOk } from "./utils/response.js";
import { formatZodError } from "./models/request.schemas.js";
import { healthRoutes } from "./routes/health.routes.js";
import { searchRoutes } from "./routes/search.routes.js";
import { busRoutes } from "./routes/bus.routes.js";
import { tramRoutes } from "./routes/tram.routes.js";
import { metroRoutes } from "./routes/metro.routes.js";
import { ferryRoutes } from "./routes/ferry.routes.js";
import { journeyRoutes } from "./routes/journey.routes.js";
import { connectionRoutes } from "./routes/connections.routes.js";
import { communityRoutes } from "./routes/community.routes.js";
import { adminRoutes } from "./routes/admin.routes.js";
import { getGraphStatus } from "./services/graph.service.js";
import { sendFrontend } from "./frontend.js";

/**
 * Fastify application factory.
 *
 * Kept separate from server.ts so tests can build an app with `app.inject()`
 * without binding a port, and so the Vercel entry point can reuse the exact
 * same configuration.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      // Vercel and most container hosts already set this.
      redact: ["req.headers.authorization", "req.headers.cookie", "req.headers['x-admin-key']"],
    },
    trustProxy: env.TRUST_PROXY,
    // Enables Fastify's schema-based validation hooks if a route later declares one.
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });

  // NOTE: register() is deliberately NOT awaited. A Fastify instance is
  // thenable, so `await app.register(...)` boots the instance immediately and
  // any later registration lands in an already-booted context whose error
  // handler no longer inherits the one set below. Registering synchronously
  // keeps the handlers below in scope for every route.
  app.register(cors, {
    origin: env.corsOrigins === "*" ? true : [...env.corsOrigins],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["content-type", "x-admin-key"],
  });

  app.register(rateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW,
    // Planning is far more expensive than a lookup, so the global budget is
    // generous: it must not throttle a map panning across many stops.
    keyGenerator: (request) => request.ip,
    addHeadersOnExceeding: { "x-ratelimit-limit": true, "x-ratelimit-remaining": true, "x-ratelimit-reset": true },
  });

  // -------------------------------------------------------------------------
  // Not found
  // -------------------------------------------------------------------------
  app.setNotFoundHandler((request, reply) => {
    // Anything that is not an API call gets the single-page frontend, so a deep
    // link such as /plan loads the app instead of a JSON 404. API paths keep
    // the JSON 404, because a client calling a missing endpoint needs to be told
    // so in the shape it is already parsing.
    if (request.method === "GET" && !request.url.startsWith("/api")) {
      if (sendFrontend(reply)) return reply;
    }
    return sendFail(
      reply,
      ErrorCode.NOT_FOUND,
      `No route matches ${request.method} ${request.url}.`,
      404,
      { hint: "Every endpoint is listed in README.md and at GET /api." },
    );
  });

  // -------------------------------------------------------------------------
  // Central error handler -- one place decides the response shape (spec 23).
  // Set before the routes so the /api plugin context inherits it.
  // -------------------------------------------------------------------------
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    if (error instanceof AppError) {
      if (error.statusCode >= 500) {
        request.log.error({ err: error, code: error.code }, "request failed");
      }
      return sendFail(reply, error.code, error.message, error.statusCode, error.details);
    }

    if (error instanceof ZodError) {
      return sendFail(reply, ErrorCode.VALIDATION_ERROR, "The request could not be validated.", 400, formatZodError(error));
    }

    // Fastify's own failures (bad JSON, unsupported media type, payload too
    // large) carry a statusCode; surface them as 4xx rather than 500.
    const statusCode = typeof error.statusCode === "number" ? error.statusCode : 500;
    if (statusCode < 500) {
      // A throttle is not a validation failure. Reporting it as VALIDATION_ERROR
      // would tell a client its request was malformed, so a well-behaved client
      // would stop retrying instead of backing off and trying again later.
      // Matched on the status rather than an error code: @fastify/rate-limit
      // throws a plain Error carrying only statusCode, so there is no code to
      // match, and 429 means exactly one thing.
      if (statusCode === 429) {
        return sendFail(reply, ErrorCode.RATE_LIMITED, error.message, statusCode);
      }
      const code =
        error.code === "FST_ERR_CTP_INVALID_JSON_BODY" || error.code === "FST_ERR_CTP_EMPTY_JSON_BODY"
          ? ErrorCode.INVALID_JSON
          : ErrorCode.VALIDATION_ERROR;
      return sendFail(reply, code, error.message, statusCode);
    }

    request.log.error({ err: error }, "unhandled error");
    return sendFail(
      reply,
      ErrorCode.INTERNAL_ERROR,
      env.isProduction ? "An unexpected error occurred." : error.message,
      500,
    );
  });

  // -------------------------------------------------------------------------
  // Routes -- all under /api so the same app can sit behind any host.
  // -------------------------------------------------------------------------
  app.register(
    async (api) => {
      await api.register(healthRoutes);
      await api.register(searchRoutes);
      await api.register(busRoutes);
      await api.register(tramRoutes);
      await api.register(metroRoutes);
      await api.register(ferryRoutes);
await api.register(journeyRoutes);
await api.register(connectionRoutes);
 await api.register(communityRoutes);
await api.register(adminRoutes);
    },
    { prefix: "/api" },
  );

  // The frontend is served for every non-API path, including "/". The service
  // index therefore lives under the API prefix, where it cannot shadow the site.
  app.get("/api", async (_request, reply) =>
    sendOk(reply, {
      service: "kolkata-transport-backend",
      documentation: "See README.md for the full endpoint list.",
      endpoints: {
        health: "GET /api/health",
        search: "GET /api/search?q=",
        bus: ["GET /api/bus/routes", "GET /api/bus/routes/:routeNo", "GET /api/bus/routes/:routeNo/stops", "GET /api/bus/routes/:routeNo/timetable", "GET /api/bus/search"],
        metro: [
          "GET /api/metro/status",
          "GET /api/metro/diagnostics",
          "GET /api/metro/stations",
          "GET /api/metro/stations/:stationId",
          "GET /api/metro/stations/:stationId/timetable",
          "GET /api/metro/routes",
          "GET /api/metro/routes/:routeId",
          "GET /api/metro/routes/:line/trips",
          "GET /api/metro/search",
        ],
        tram: [
          "GET /api/tram/status",
          "GET /api/tram/diagnostics",
          "GET /api/tram/routes",
          "GET /api/tram/routes/:routeNo",
          "GET /api/tram/routes/:routeNo/stops",
          "GET /api/tram/routes/:routeNo/legs",
          "GET /api/tram/routes/:routeNo/timetable",
          "GET /api/tram/heritage",
          "GET /api/tram/excluded",
          "GET /api/tram/search",
        ],
        ferry: [
          "GET /api/ferry/status",
          "GET /api/ferry/diagnostics",
          "GET /api/ferry/routes",
          "GET /api/ferry/routes/:routeNo",
          "GET /api/ferry/routes/:routeNo/stops",
          "GET /api/ferry/routes/:routeNo/timetable",
          "GET /api/ferry/ghats",
          "GET /api/ferry/search",
        ],
        journey: "POST /api/journey",
        connections: "GET /api/routes/:routeNo/connections?mode=",
        community: [
          "GET /api/community/:mode",
          "POST /api/community/:mode",
          "GET /api/community/:mode/:route",
          "POST /api/community/:mode/:route",
        ],
        graph: ["GET /api/graph/stats", "GET /api/graph/transfers"],
        admin: [
          "GET /api/admin/status",
          "POST /api/admin/graph/refresh",
          "GET /api/admin/routes/aliases?mode=",
          "POST /api/admin/routes/alias",
          "POST /api/admin/community/sweep",
        ],
      },
      databaseConfigured: env.hasDatabase,
    }),
  );

  return app;
}

export { getGraphStatus };

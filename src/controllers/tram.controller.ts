import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { TramService } from "../services/modes.service.js";
import { AppError, ErrorCode } from "../utils/errors.js";
import { handle, parseOrThrow } from "./base.controller.js";
import { routeNoParamSchema, tramRouteListQuerySchema, tramSearchQuerySchema } from "../models/request.schemas.js";

/**
 * Tram endpoints.
 *
 * These previously returned 410 Gone on the premise that Kolkata's tram service
 * had been withdrawn. That premise was wrong: the network is still in operation
 * and the current route data is OPERATIONAL, so the endpoints now serve the two
 * live regular commuter routes.
 *
 * Three things are deliberately kept apart here:
 *   - Regular routes (`tram_routes`/`tram_stops`/`tram_legs`) are routable.
 *   - Heritage services are informational and read-only.
 *   - Historical routes are listed with the reason they are excluded.
 *
 * Service is reported as irregular in the source data, so no departure is
 * invented: a request for a timetable returns the published service window and
 * says that no fixed headway is verified.
 */

const tramParamsSchema = z.object({ routeNo: routeNoParamSchema });

/** GET /api/tram/status */
export async function tramStatus(_request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  return handle(reply, async () => ({
    mode: "TRAM" as const,
    implemented: true,
    configured: await TramService.isConfigured(),
    requiredTables: TramService.requiredTables,
    note:
      "Only current regular commuter routes are routed. Heritage and special services are " +
      "informational and are never used for journey planning.",
    timetablePolicy:
      "Tram service is reported as irregular, so no fixed headway is assumed. Journey timings on " +
      "tram legs are estimates, never exact scheduled times.",
  }));
}

/** GET /api/tram/routes */
export async function listTramRoutes(
  request: FastifyRequest<{ Querystring: unknown }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  return handle(reply, async () => {
    const filter = parseOrThrow(tramRouteListQuerySchema, request.query);
    const [rows, total] = await Promise.all([
      TramService.listRoutes(filter),
      TramService.countRoutes(filter.status),
    ]);
    return {
      items: rows,
      page: {
        total,
        limit: filter.limit,
        offset: filter.offset,
        returned: rows.length,
        hasMore: filter.offset + rows.length < total,
      },
    };
  });
}

/** GET /api/tram/routes/:routeNo */
export async function getTramRoute(
  request: FastifyRequest<{ Params: unknown }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  return handle(reply, async () => {
    const { routeNo } = parseOrThrow(tramParamsSchema, request.params);
    const route = await TramService.getRoute(routeNo);
    if (!route) {
      throw new AppError(ErrorCode.NOT_FOUND, `No tram route with id '${routeNo}'.`, { routeNo });
    }
    return route;
  });
}

/**
 * GET /api/tram/routes/:routeNo/stops
 *
 * Stops in the supplied `stop_sequence` order, never alphabetically.
 */
export async function getTramStops(
  request: FastifyRequest<{ Params: unknown }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  return handle(reply, async () => {
    const { routeNo } = parseOrThrow(tramParamsSchema, request.params);
    return { routeId: routeNo, stops: await TramService.getRouteStops(routeNo) };
  });
}

/** GET /api/tram/routes/:routeNo/legs */
export async function getTramLegs(
  request: FastifyRequest<{ Params: unknown }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  return handle(reply, async () => {
    const { routeNo } = parseOrThrow(tramParamsSchema, request.params);
    return { routeId: routeNo, legs: await TramService.getRouteLegs(routeNo) };
  });
}

/**
 * GET /api/tram/routes/:routeNo/timetable
 *
 * Returns the published service window. For an irregular service the window is
 * present but the headway is not, and that is reported as-is rather than
 * interpolated into "every N minutes".
 */
export async function getTramTimetable(
  request: FastifyRequest<{ Params: unknown }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  return handle(reply, async () => {
    const { routeNo } = parseOrThrow(tramParamsSchema, request.params);
    const services = await TramService.getRouteServices(routeNo);
    return { routeId: routeNo, services };
  });
}

/**
 * GET /api/tram/heritage
 *
 * Special and heritage tram services. Informational only: these never enter the
 * journey graph, so a heritage tram will never appear as a journey leg.
 */
export async function listTramHeritage(
  _request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  return handle(reply, async () => ({
    count: (await TramService.listHeritageServices()).length,
    note: "Informational only. Heritage and special services are not used for journey planning.",
    items: await TramService.listHeritageServices(),
  }));
}

/**
 * GET /api/tram/excluded
 *
 * Historical routes that exist in the record but are deliberately kept out of
 * the live graph, each with the reason it is excluded.
 */
export async function listTramExcluded(
  _request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  return handle(reply, async () => {
    const items = await TramService.listExcludedHistoricalRoutes();
    return { count: items.length, note: "Historical routes excluded from the live graph.", items };
  });
}

/** GET /api/tram/search?q=... */
export async function searchTram(
  request: FastifyRequest<{ Querystring: unknown }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  return handle(reply, async () => {
    const query = parseOrThrow(tramSearchQuerySchema, request.query);
    const results = await TramService.searchStops(query.q, query.limit);
    return { query: query.q, mode: "TRAM", count: results.length, results };
  });
}

/** GET /api/tram/diagnostics */
export async function tramDiagnostics(
  _request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  return handle(reply, () => TramService.diagnostics());
}

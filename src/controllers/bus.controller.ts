import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  modeQuerySchema,
  routeListQuerySchema,
  routeNoParamSchema,
  timetableQuerySchema,
} from "../models/request.schemas.js";
import { getBusService } from "../services/bus.service.js";
import { getSearchService } from "../services/search.service.js";
import { parseClockToMinutes } from "../utils/time.js";
import { AppError, ErrorCode } from "../utils/errors.js";
import { handle, parseOrThrow } from "./base.controller.js";

const routeParamsSchema = z.object({ routeNo: routeNoParamSchema });
const busSearchQuerySchema = modeQuerySchema.extend({
  q: z.string().trim().min(1, "q must not be empty").max(120),
});

/**
 * Reads the route number from the path parameter, falling back to a
 * `?routeNo=` query parameter.
 *
 * Some real route numbers contain a slash (C-14/1, B-1/2). In a path segment
 * that slash is a path separator, so `/api/bus/routes/C-14/1/stops` can never
 * reach a handler no matter how it is escaped on the client side. The
 * by-number endpoints exist so such routes stay reachable without callers having
 * to know about percent-encoding.
 */
export function readRouteNo(request: FastifyRequest, params: unknown, query: unknown): string {
  const fromPath = routeParamsSchema.partial().safeParse(params);
  if (fromPath.success && fromPath.data.routeNo) return fromPath.data.routeNo;
  const fromQuery = z.object({ routeNo: routeNoParamSchema }).safeParse(query);
  if (fromQuery.success) return fromQuery.data.routeNo;
  throw new AppError(
    ErrorCode.INVALID_QUERY,
    "A route number is required, as the :routeNo path parameter or a ?routeNo= query parameter.",
  );
}

/** GET /api/bus/routes */
export async function listBusRoutes(
  request: FastifyRequest<{ Querystring: unknown }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  return handle(reply, async () => getBusService().listRoutes(parseOrThrow(routeListQuerySchema, request.query)));
}

/** GET /api/bus/routes/:routeNo (also GET /api/bus/routes/by-number?routeNo=) */
export async function getBusRoute(
  request: FastifyRequest<{ Params: unknown; Querystring: { operator?: string; routeNo?: string } }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  return handle(reply, async () => {
    const routeNo = readRouteNo(request, request.params, request.query);
    return getBusService().getRoute(routeNo, request.query.operator);
  });
}

/** GET /api/bus/routes/:routeNo/stops (also /api/bus/routes/by-number/stops?routeNo=) */
export async function getBusRouteStops(
  request: FastifyRequest<{ Params: unknown; Querystring: { operator?: string; routeNo?: string } }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  return handle(reply, async () => {
    const routeNo = readRouteNo(request, request.params, request.query);
    const { routeNo: canonical, operator, mode, stops } = await getBusService().getRouteStops(
      routeNo,
      request.query.operator,
    );
    return { routeNo: canonical, requestedRouteNo: routeNo, operator, mode, stopCount: stops.length, stops };
  });
}

/** GET /api/bus/routes/:routeNo/timetable (also /api/bus/routes/by-number/timetable?routeNo=) */
export async function getBusTimetable(
  request: FastifyRequest<{ Params: unknown; Querystring: { routeNo?: string } & unknown }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  return handle(reply, async () => {
    const routeNo = readRouteNo(request, request.params, request.query);
    const query = parseOrThrow(timetableQuerySchema, request.query);

    let fromMinutes: number | undefined;
    if (query.from) {
      const parsed = parseClockToMinutes(query.from);
      if (parsed === null) {
        throw new AppError(ErrorCode.INVALID_QUERY, `from="${query.from}" is not a valid HH:MM time.`);
      }
      fromMinutes = parsed;
    }

    return getBusService().getTimetable(routeNo, {
      operator: query.operator,
      directionId: query.directionId,
      fromMinutes,
      limit: query.limit,
      offset: query.offset,
    });
  });
}

/** GET /api/bus/search?q=... */
export async function searchBus(
  request: FastifyRequest<{ Querystring: unknown }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  return handle(reply, async () => {
    const query = parseOrThrow(busSearchQuerySchema, request.query);
    const results = await getSearchService().search({ q: query.q, mode: "BUS", limit: query.limit });
    return { query: query.q, mode: "BUS", count: results.length, results };
  });
}

/** GET /api/bus/timetable-routes */
export async function listTimetableRoutes(
  _request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  return handle(reply, async () => {
    const routes = await getBusService().listTimetableRoutes();
    return { count: routes.length, routes };
  });
}

/** GET /api/bus/diagnostics */
export async function busDiagnostics(_request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  return handle(reply, async () => getBusService().diagnostics());
}

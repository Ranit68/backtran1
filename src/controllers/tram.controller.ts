import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  modeQuerySchema,
  routeNoParamSchema,
  tramRouteListQuerySchema,
} from "../models/request.schemas.js";
import { getTramService } from "../services/tram.service.js";
import { getSearchService } from "../services/search.service.js";
import { readRouteNo } from "./bus.controller.js";
import { handle, parseOrThrow } from "./base.controller.js";

const routeParamsSchema = z.object({ routeNo: routeNoParamSchema });
const tramSearchQuerySchema = modeQuerySchema.extend({
  q: z.string().trim().min(1, "q must not be empty").max(120),
});

/** GET /api/tram/routes */
export async function listTramRoutes(
  request: FastifyRequest<{ Querystring: unknown }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  return handle(reply, async () =>
    getTramService().listRoutes(parseOrThrow(tramRouteListQuerySchema, request.query)),
  );
}

/** GET /api/tram/routes/:routeNo (also GET /api/tram/routes/by-number?routeNo=) */
export async function getTramRoute(
  request: FastifyRequest<{ Params: unknown; Querystring: { operator?: string; routeNo?: string } }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  return handle(reply, async () => {
    const routeNo = readRouteNo(request, request.params, request.query);
    return getTramService().getRoute(routeNo, request.query.operator);
  });
}

/** GET /api/tram/routes/:routeNo/stops (also /api/tram/routes/by-number/stops?routeNo=) */
export async function getTramRouteStops(
  request: FastifyRequest<{ Params: unknown; Querystring: { operator?: string; routeNo?: string } }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  return handle(reply, async () => {
    const routeNo = readRouteNo(request, request.params, request.query);
    const { routeNo: canonical, operator, mode, stops } = await getTramService().getRouteStops(
      routeNo,
      request.query.operator,
    );
    return { routeNo: canonical, requestedRouteNo: routeNo, operator, mode, stopCount: stops.length, stops };
  });
}

/** GET /api/tram/search?q=... */
export async function searchTram(
  request: FastifyRequest<{ Querystring: unknown }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  return handle(reply, async () => {
    const query = parseOrThrow(tramSearchQuerySchema, request.query);
    const results = await getSearchService().search({ q: query.q, mode: "TRAM", limit: query.limit });
    return { query: query.q, mode: "TRAM", count: results.length, results };
  });
}

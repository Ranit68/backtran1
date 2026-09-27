import type { FastifyReply, FastifyRequest } from "fastify";
import { MetroService, FerryService } from "../services/modes.service.js";
import { handle, parseOrThrow } from "./base.controller.js";
import { z } from "zod";
import { modeQuerySchema, routeNoParamSchema } from "../models/request.schemas.js";

const stationParamsSchema = z.object({ stationId: z.string().trim().min(1).max(80) });
const routeIdParamsSchema = z.object({ routeId: z.string().trim().min(1).max(80) });
const metroSearchSchema = modeQuerySchema.extend({
  q: z.string().trim().min(1, "q must not be empty").max(120),
});

/**
 * Metro endpoints from the specification's endpoint list, plus the two that
 * section 9 implies (station detail and a mode status route).
 *
 * All of them currently return 501 METRO_NOT_CONFIGURED. The routes exist so
 * that the API surface is complete and clients can be written against it; the
 * handlers are the single place to change once an existing GTFS-style Metro
 * implementation is pointed at.
 */

/** GET /api/metro/stations */
export async function listMetroStations(_request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  return handle(reply, () => MetroService.listStations());
}

/** GET /api/metro/stations/:stationId */
export async function getMetroStation(
  request: FastifyRequest<{ Params: unknown }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  return handle(reply, async () => {
    const { stationId } = parseOrThrow(stationParamsSchema, request.params);
    return MetroService.getStation(stationId);
  });
}

/** GET /api/metro/routes */
export async function listMetroRoutes(_request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  return handle(reply, () => MetroService.listRoutes());
}

/** GET /api/metro/routes/:routeId */
export async function getMetroRoute(
  request: FastifyRequest<{ Params: unknown }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  return handle(reply, async () => {
    const { routeId } = parseOrThrow(routeIdParamsSchema, request.params);
    return MetroService.getRoute(routeId);
  });
}

/** GET /api/metro/search?q=... */
export async function searchMetro(
  request: FastifyRequest<{ Querystring: unknown }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  return handle(reply, async () => {
    const query = parseOrThrow(metroSearchSchema, request.query);
    return { query: query.q, mode: "METRO", count: 0, results: await MetroService.searchStations(query.q, query.limit) };
  });
}

/** GET /api/metro/status -- always 200, describes why Metro is unavailable. */
export async function metroStatus(_request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  return reply.status(200).send({ success: true, data: MetroService.status() });
}

/** GET /api/ferry/status */
export async function ferryStatus(_request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  return handle(reply, async () => FerryService.status());
}

const ferryParamsSchema = z.object({ routeNo: routeNoParamSchema });

/** GET /api/ferry/routes */
export async function listFerryRoutes(_request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  return handle(reply, () => FerryService.listRoutes());
}

/** GET /api/ferry/routes/:routeNo */
export async function getFerryRoute(
  request: FastifyRequest<{ Params: unknown }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  return handle(reply, async () => {
    const { routeNo } = parseOrThrow(ferryParamsSchema, request.params);
    return FerryService.getRoute(routeNo);
  });
}

/** GET /api/ferry/routes/:routeNo/stops */
export async function getFerryStops(
  request: FastifyRequest<{ Params: unknown }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  return handle(reply, async () => {
    const { routeNo } = parseOrThrow(ferryParamsSchema, request.params);
    return FerryService.getStops(routeNo);
  });
}

/** GET /api/ferry/routes/:routeNo/timetable */
export async function getFerryTimetable(
  request: FastifyRequest<{ Params: unknown }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  return handle(reply, async () => {
    const { routeNo } = parseOrThrow(ferryParamsSchema, request.params);
    return FerryService.getTimetable(routeNo);
  });
}

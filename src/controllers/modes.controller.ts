import type { FastifyReply, FastifyRequest } from "fastify";
import { MetroService, FerryService } from "../services/modes.service.js";
import { handle, parseOrThrow } from "./base.controller.js";
import { z } from "zod";
import {
  metroLineListQuerySchema,
  metroStationListQuerySchema,
  metroStationTimetableQuerySchema,
  metroTripListQuerySchema,
  modeQuerySchema,
  routeNoParamSchema,
} from "../models/request.schemas.js";

const stationParamsSchema = z.object({ stationId: z.string().trim().min(1).max(80) });
const routeIdParamsSchema = z.object({ routeId: z.string().trim().min(1).max(80) });
const metroSearchSchema = modeQuerySchema.extend({
  q: z.string().trim().min(1, "q must not be empty").max(120),
});

/**
 * Metro endpoints, all reading the four existing Metro tables.
 *
 * A Metro "route" is a line. Line detail, station detail, real trips and real
 * per-station departure times are all served, and a station that exists on a
 * line but has no printed time says so in its `note` rather than being hidden.
 */

/** GET /api/metro/stations?line=&q= */
export async function listMetroStations(
  request: FastifyRequest<{ Querystring: unknown }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  return handle(reply, async () => {
    const query = parseOrThrow(metroStationListQuerySchema, request.query);
    return MetroService.listStations(query);
  });
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

/** GET /api/metro/stations/:stationId/timetable -- real scheduled departures. */
export async function getMetroStationTimetable(
  request: FastifyRequest<{ Params: unknown; Querystring: unknown }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  return handle(reply, async () => {
    const { stationId } = parseOrThrow(stationParamsSchema, request.params);
    const query = parseOrThrow(metroStationTimetableQuerySchema, request.query);
    return MetroService.getStationTimetable(stationId, query);
  });
}

/** GET /api/metro/routes?sort=&q= */
export async function listMetroRoutes(
  request: FastifyRequest<{ Querystring: unknown }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  return handle(reply, async () => {
    const query = parseOrThrow(metroLineListQuerySchema, request.query);
    return MetroService.listRoutes(query);
  });
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

/** GET /api/metro/routes/:line/trips */
export async function listMetroTrips(
  request: FastifyRequest<{ Params: unknown; Querystring: unknown }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  return handle(reply, async () => {
    const { line } = parseOrThrow(z.object({ line: z.string().trim().min(1).max(40) }), request.params);
    const query = parseOrThrow(metroTripListQuerySchema, { ...(request.query as object), line });
    return MetroService.listTrips(query);
  });
}

/** GET /api/metro/search?q=... */
export async function searchMetro(
  request: FastifyRequest<{ Querystring: unknown }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  return handle(reply, async () => {
    const query = parseOrThrow(metroSearchSchema, request.query);
    const results = await MetroService.searchStations(query.q, query.limit);
    return { query: query.q, mode: "METRO", count: results.length, results };
  });
}

/** GET /api/metro/diagnostics -- where the supplied data stops and starts. */
export async function metroDiagnostics(_request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  return handle(reply, () => MetroService.diagnostics());
}

/** GET /api/metro/status -- always 200, describes the Metro data coverage. */
export async function metroStatus(_request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  return handle(reply, async () => ({
    ...MetroService.status(),
    configured: await MetroService.isConfigured(),
  }));
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

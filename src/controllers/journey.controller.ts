import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { journeyRequestSchema } from "../models/request.schemas.js";
import { getJourneyService } from "../services/journey.service.js";
import { getCachedGraph, getGraph, getGraphStatus } from "../services/graph.service.js";
import { env } from "../config/env.js";
import { handle, parseOrThrow } from "./base.controller.js";

/** POST /api/journey */
export async function planJourney(
  request: FastifyRequest<{ Body: unknown }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  return handle(reply, async () => {
    const body = parseOrThrow(journeyRequestSchema, request.body);
    return getJourneyService().plan({
      source: body.source,
      destination: body.destination,
      mode: body.mode,
      strategy: body.strategy,
      departureTime: body.departureTime,
      timetableAware: body.timetableAware,
    });
  });
}

/**
 * GET /api/graph/stats
 *
 * Forces a build when the cache is cold, because "stats with no graph" is not a
 * useful answer for an operator trying to verify an import.
 */
export async function graphStats(_request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  return handle(reply, async () => {
    const graph = getCachedGraph() ?? (await getGraph());
    return {
      cache: getGraphStatus(),
      config: {
        maxTransferDistanceMeters: env.MAX_TRANSFER_DISTANCE_METERS,
        transferNameSimilarityThreshold: env.TRANSFER_NAME_SIMILARITY_THRESHOLD,
        defaultTransferMinutes: env.DEFAULT_TRANSFER_MINUTES,
        // Allowance for changing vehicle at a stop, reported so a client can
        // tell a real timetable duration from a planning assumption.
        minInterchangeMinutes: env.MIN_INTERCHANGE_MINUTES,
        graphCacheTtlSeconds: env.GRAPH_CACHE_TTL_SECONDS,
        graphRebuildMinIntervalSeconds: env.GRAPH_REBUILD_MIN_INTERVAL_SECONDS,
      },
      stats: graph.data.stats,
      excludedPlaceholderStops: graph.data.excludedStops,
    };
  });
}

/**
 * GET /api/graph/transfers
 *
 * Exposes how each transfer was detected, because the specification is explicit
 * that the mechanism must be inspectable rather than a black box.
 */
export async function graphTransfers(
  request: FastifyRequest<{ Querystring: { limit?: string } }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  return handle(reply, async () => {
    const graph = getCachedGraph() ?? (await getGraph());
    const requested = Number(request.query.limit ?? 100);
    const limit = Number.isFinite(requested) ? Math.min(Math.max(Math.floor(requested), 1), 1000) : 100;

    const transfers = graph.data.transfers.slice(0, limit).map((candidate) => ({
      from: {
        nodeId: candidate.from.id,
        name: candidate.from.name,
        mode: candidate.from.mode,
        operator: candidate.from.operator ?? null,
      },
      to: {
        nodeId: candidate.to.id,
        name: candidate.to.name,
        mode: candidate.to.mode,
        operator: candidate.to.operator ?? null,
      },
      reason: candidate.reason,
      nameSimilarity: candidate.nameSimilarity,
      // null whenever the pair has no coordinates. Never estimated.
      distanceMeters: candidate.distanceMeters,
      transferTimeMinutes: candidate.transferTimeMinutes,
    }));

    return {
      total: graph.data.transfers.length,
      returned: transfers.length,
      detectionStats: graph.data.stats.transferDetection,
      reasons: graph.data.stats.transferReasons,
      transfers,
    };
  });
}

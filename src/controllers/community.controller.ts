import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { AppError, ErrorCode } from "../utils/errors.js";
import {
  REPORT_MESSAGE_MAX_LENGTH,
  type CommunityMode,
} from "../models/community.model.js";
import {
  createReport,
  listReports,
  normaliseMessage,
  resolveRouteScope,
} from "../repositories/community.repository.js";
import { handle, parseOrThrow } from "./base.controller.js";

/**
 * Route-scoped community reports.
 *
 * GET  /api/community/:mode/:route  -- the feed for one route
 * POST /api/community/:mode/:route  -- leave a report about that route
 *
 * Posts are anonymous text that live for 24 hours. There is no account system
 * in this service, so nothing here pretends to know who wrote a post; see
 * community.model.ts for why that is a decision rather than a gap.
 *
 * The route in the path is always resolved against the real route tables before
 * anything is written. A post about a route that does not exist would be
 * invisible to everyone forever, because the feed can only ever be fetched by a
 * real route, so accepting one would be a silent data loss bug.
 */

const modeSchema = z.enum(["BUS", "METRO", "FERRY", "TRAM"]);

const routeParamSchema = z.object({
  mode: modeSchema,
  // Same reason as the connections route: real route numbers include
  // "T-2 (Khidirpur)" and "C-11/1".
  route: z
    .string()
    .trim()
    .min(1, "route is required")
    .max(64, "route must be at most 64 characters"),
});

const feedQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const postBodySchema = z.object({
  message: z
    .string()
    .min(1, "message is required")
    // The limit is declared here, not only in the database, so the client is
    // told the number in the validation error instead of guessing at it.
    .max(
      REPORT_MESSAGE_MAX_LENGTH,
      `message must be at most ${REPORT_MESSAGE_MAX_LENGTH} characters`,
    ),
});

/** Resolves the route, or fails with a message naming the mode that was asked for. */
async function requireScope(mode: CommunityMode, route: string) {
  const scope = await resolveRouteScope(mode, route);
  if (!scope) {
    throw new AppError(
      ErrorCode.ROUTE_NOT_FOUND,
      `No ${mode} route matching "${route}" was found, so there is no community to post to.`,
    );
  }
  return scope;
}

export async function getCommunityFeed(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  return handle(reply, async () => {
    const params = parseOrThrow(routeParamSchema, request.params);
    const query = parseOrThrow(feedQuerySchema, request.query);
    const scope = await requireScope(params.mode, params.route);
    return listReports(scope, query.limit);
  });
}

export async function postCommunityReport(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  return handle(reply, async () => {
    const params = parseOrThrow(routeParamSchema, request.params);
    const body = parseOrThrow(postBodySchema, request.body);

    const message = normaliseMessage(body.message);
    // Whitespace-only input passes a .min(1) check, so it is rejected after
    // normalisation rather than becoming a blank post in the feed.
    if (!message) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        "The request could not be validated.",
        [{ field: "message", message: "message cannot be only whitespace" }],
      );
    }

    const scope = await requireScope(params.mode, params.route);
    // 201: a report was created, and the caller gets the stored row back so it
    // can render the post it just made without refetching the feed.
    return createReport(scope, message);
  }, 201);
}

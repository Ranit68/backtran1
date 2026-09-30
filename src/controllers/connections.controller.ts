import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { AppError, ErrorCode } from "../utils/errors.js";
import { getRouteConnections } from "../repositories/connections.repository.js";
import { handle, parseOrThrow } from "./base.controller.js";
import { routeNoParamSchema } from "../models/request.schemas.js";

/**
 * GET /api/routes/:routeNo/connections
 *
 * Reports the other services reachable from one route, with the first and last
 * service in each direction and, for Metro, the platform to look for.
 *
 * The platform number is the reason this endpoint is careful about wording. The
 * data set marks some platform numbers as inferred or as contested between
 * sources, and a contested platform number is worse than none because it is
 * believed. So every platform carries its verification status, and the response
 * carries a warning string whenever any of them should not be taken at face
 * value. The number is still returned: "1, unverified" helps a passenger far
 * more than a blank, as long as the doubt is visible.
 */

const connectionsQuerySchema = z.object({
  mode: z
    .enum(["BUS", "METRO", "FERRY", "TRAM"])
    .default("BUS")
    .describe("Which mode the route number belongs to."),
});

const paramsSchema = z.object({ routeNo: routeNoParamSchema });

export async function getConnections(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  return handle(reply, async () => {
    const params = parseOrThrow(paramsSchema, request.params);
    const query = parseOrThrow(connectionsQuerySchema, request.query);

    const result = await getRouteConnections(query.mode, params.routeNo);

    // A miss means the route is in neither the stop table nor the timetable. A
    // route that exists but connects to nothing is not a miss: it is a route
    // with an honest empty list, and answering 404 would tell the rider their
    // route number is wrong when it is not.
    if (!result) {
      throw new AppError(
        ErrorCode.NOT_FOUND,
        `No ${query.mode} route matching "${params.routeNo}" was found.`,
      );
    }

    return result;
  });
}

import type { FastifyReply, FastifyRequest } from "fastify";
import { searchQuerySchema } from "../models/request.schemas.js";
import { getSearchService } from "../services/search.service.js";
import { handle, parseOrThrow } from "./base.controller.js";

/** GET /api/search?q=...&mode=ALL&limit=20 */
export async function globalSearch(
  request: FastifyRequest<{ Querystring: unknown }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  return handle(reply, async () => {
    const query = parseOrThrow(searchQuerySchema, request.query);
    const results = await getSearchService().search({
      q: query.q,
      mode: query.mode,
      limit: query.limit,
    });
    return {
      query: query.q,
      mode: query.mode,
      count: results.length,
      results,
    };
  });
}

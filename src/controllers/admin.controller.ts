import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { query, withTransaction } from "../config/database.js";
import { requireDatabase } from "../repositories/base.repository.js";
import { refreshGraph } from "../services/graph.service.js";
import { env } from "../config/env.js";
import { handle, parseOrThrow } from "./base.controller.js";
import { TRANSPORT_MODES } from "../types/transport.js";

const refreshQuerySchema = z.object({
  force: z
    .union([z.boolean(), z.string()])
    .transform((value) =>
      typeof value === "boolean" ? value : ["1", "true", "yes"].includes(value.toLowerCase()),
    )
    .default(false),
});

const aliasBodySchema = z.object({
  mode: z.enum(TRANSPORT_MODES as unknown as [string, ...string[]]).default("BUS"),
  /** Route number as it appears in the route-stop data. */
  sourceRouteNo: z.string().trim().min(1).max(50),
  /** Route number as it appears in the timetable data. */
  targetRouteNo: z.string().trim().min(1).max(50),
  note: z.string().trim().max(500).optional(),
});

interface AliasRow {
  mode: string;
  source_route_no: string;
  target_route_no: string;
  note: string | null;
  created_at: Date;
}

/**
 * POST /api/admin/graph/refresh?force=true
 *
 * The mechanism the specification requires for "when transport data changes"
 * (section 25). Requires x-admin-key.
 */
export async function refreshTransportGraph(
  request: FastifyRequest<{ Querystring: unknown }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  return handle(reply, async () => {
    const { force } = parseOrThrow(refreshQuerySchema, request.query ?? {});
    const stats = await refreshGraph({ force });
    return { refreshed: true, forced: force, stats };
  });
}

/**
 * GET /api/admin/routes/aliases
 *
 * The route-number bridge between the route-stop namespace (WBTC, e.g. "1A")
 * and the timetable namespace (CSTC, e.g. "AC-3"). The source data only overlaps
 * on AC-3 and AC-4, so the rest of the mapping has to come from a human.
 */
export async function listRouteAliases(
  request: FastifyRequest<{ Querystring: { mode?: string } }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  return handle(reply, async () => {
    requireDatabase();
    const rows = await query<AliasRow>(
      `SELECT mode, source_route_no, target_route_no, note, created_at
       FROM route_aliases
       WHERE ($1::text IS NULL OR mode = $1::text)
       ORDER BY mode ASC, source_route_no ASC`,
      [request.query.mode ?? null],
    );
    return {
      count: rows.length,
      aliases: rows.map((row) => ({
        mode: row.mode,
        sourceRouteNo: row.source_route_no,
        targetRouteNo: row.target_route_no,
        note: row.note,
        createdAt: row.created_at.toISOString(),
      })),
    };
  });
}

/** POST /api/admin/routes/alias */
export async function createRouteAlias(
  request: FastifyRequest<{ Body: unknown }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  return handle(reply, async () => {
    requireDatabase();
    const body = parseOrThrow(aliasBodySchema, request.body);
    return withTransaction(async (client) => {
      const { rows } = await client.query<AliasRow>(
        `INSERT INTO route_aliases (mode, source_route_no, target_route_no, note)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (mode, source_route_no, target_route_no)
         DO UPDATE SET note = EXCLUDED.note
         RETURNING mode, source_route_no, target_route_no, note, created_at`,
        [body.mode, body.sourceRouteNo, body.targetRouteNo, body.note ?? null],
      );
      const alias = rows[0];
      return {
        created: true,
        alias: alias
          ? {
              mode: alias.mode,
              sourceRouteNo: alias.source_route_no,
              targetRouteNo: alias.target_route_no,
              note: alias.note,
              createdAt: alias.created_at.toISOString(),
            }
          : null,
      };
    });
  }, 201);
}

/** GET /api/admin/status -- is the admin surface usable at all? */
export async function adminStatus(_request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  return handle(reply, async () => ({
    enabled: Boolean(env.ADMIN_KEY),
    authHeader: "x-admin-key",
    endpoints: [
      "POST /api/admin/graph/refresh?force=true",
      "GET  /api/admin/routes/aliases?mode=BUS",
      "POST /api/admin/routes/alias",
    ],
  }));
}

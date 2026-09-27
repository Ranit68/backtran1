import type { FastifyReply, FastifyRequest } from "fastify";
import { pingDatabase } from "../config/database.js";
import { env } from "../config/env.js";
import { getGraphStatus } from "../services/graph.service.js";
import { isMetroConfigured } from "../repositories/metro.repository.js";
import { FERRY_NOT_CONFIGURED_MESSAGE } from "../repositories/ferry.repository.js";
import { RETIRED_TRANSPORT_MODES, TRAM_WITHDRAWAL_NOTE } from "../types/transport.js";
import { sendOk } from "../utils/response.js";

/**
 * GET /api/health
 *
 * Never throws and never returns 5xx. A health check that goes red whenever the
 * database hiccups gets the deployment killed by a load balancer, so component
 * status is reported inside a 200 response instead.
 */
export async function health(_request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const database = await pingDatabase();
  const graph = getGraphStatus();
  // Never rejects: isMetroConfigured returns false on any database error, and
  // this endpoint must stay 200 even when the database is unreachable.
  const metroConfigured = await isMetroConfigured();

  return sendOk(reply, {
    status: "ok",
    service: "kolkata-transport-backend",
    version: "1.0.0",
    environment: env.NODE_ENV,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    components: {
      database: {
        configured: env.hasDatabase,
        reachable: database.ok,
        detail: database.ok ? undefined : database.detail,
      },
      graph: {
        built: graph.built,
        stale: graph.stale,
        nodeCount: graph.nodeCount,
        lastBuiltAt: graph.lastBuiltAt,
        lastBuildError: graph.lastBuildError,
      },
    },
    modes: {
      BUS: {
        implemented: true,
        dataSource: "wbtc_bus_routes.csv (route stops) + wbtc_bus_timetable_final.csv (timetable)",
      },
      METRO: {
        implemented: true,
        // The source coverage is uneven, so it is named rather than implied: the
        // Pink Line has no timetable and most stations have no printed time.
        dataSource: "metro_routes + metro_stations (all lines) + metro_trips + metro_timetable_checkpoints",
        configured: metroConfigured,
        coverageNote:
          "All six lines have a full station list. Timetables were supplied for the Blue, Green, Orange, Purple and Yellow lines only, and only some stations have a printed time.",
      },
      FERRY: { implemented: false, reason: FERRY_NOT_CONFIGURED_MESSAGE },
    },
    retiredModes: Object.fromEntries(
      RETIRED_TRANSPORT_MODES.map((mode) => [mode, TRAM_WITHDRAWAL_NOTE]),
    ),
  });
}

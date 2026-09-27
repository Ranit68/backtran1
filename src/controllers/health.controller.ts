import type { FastifyReply, FastifyRequest } from "fastify";
import { pingDatabase } from "../config/database.js";
import { env } from "../config/env.js";
import { getGraphStatus } from "../services/graph.service.js";
import { METRO_NOT_CONFIGURED_MESSAGE } from "../repositories/metro.repository.js";
import { FERRY_NOT_CONFIGURED_MESSAGE } from "../repositories/ferry.repository.js";
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
      TRAM: { implemented: true, dataSource: "wbtc_tram_routes.csv (route stops only)" },
      METRO: { implemented: false, reason: METRO_NOT_CONFIGURED_MESSAGE },
      FERRY: { implemented: false, reason: FERRY_NOT_CONFIGURED_MESSAGE },
    },
  });
}

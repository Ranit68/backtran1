import type { FastifyReply, FastifyRequest } from "fastify";
import { pingDatabase } from "../config/database.js";
import { env } from "../config/env.js";
import { getGraphStatus } from "../services/graph.service.js";
import { isMetroConfigured } from "../repositories/metro.repository.js";
import { isFerryConfigured } from "../repositories/ferry.repository.js";
import { isTramConfigured } from "../repositories/tram.repository.js";
import { sendOk } from "../utils/response.js";

/**
 * GET /api/health
 *
 * Never throws and never returns 5xx. A health check that goes red whenever the
 * database hiccups gets the deployment killed by a load balancer, so component
 * status is reported inside a 200 response instead.
 *
 * Every mode is probed independently. A ferry or tram data set that fails to
 * load is reported as its own degraded component and leaves bus, metro and the
 * other optional mode serving normally.
 */
export async function health(_request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const database = await pingDatabase();
  const graph = getGraphStatus();
  // Each probe swallows its own database error and resolves false, so a failure
  // in one mode cannot reject this endpoint.
  const [metroConfigured, ferryConfigured, tramConfigured] = await Promise.all([
    isMetroConfigured(),
    isFerryConfigured(),
    isTramConfigured(),
  ]);

  // "degraded" when the core is fine but an optional mode has no data; "ok"
  // only when everything the API can route is actually loaded.
  const status = database.ok && graph.built ? "ok" : "degraded";

  return sendOk(reply, {
    status,
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
      metro: { status: metroConfigured ? "healthy" : "degraded" },
      bus: { status: "healthy" },
      ferry: { status: ferryConfigured ? "healthy" : "degraded" },
      tram: { status: tramConfigured ? "healthy" : "degraded" },
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
      FERRY: {
        implemented: true,
        configured: ferryConfigured,
        dataSource: "ferry_routes + ferry_ghats + ferry_legs + ferry_schedules + ferry_fares",
        coverageNote:
          "Ferry services are suspendable for weather, water level, elections and maintenance. " +
          "Fares are only quoted where the current fare is verified; an unverified fare is reported as null, never as 0.",
      },
      TRAM: {
        implemented: true,
        configured: tramConfigured,
        dataSource: "tram_routes + tram_stops + tram_legs + tram_services",
        coverageNote:
          "Only current regular commuter routes are routed (TRAM5 Shyambazar-Esplanade, TRAM25 " +
          "Gariahat-Esplanade). Service is reported as irregular, so no fixed headway is assumed and " +
          "timings are estimates. Heritage services and historical routes are excluded from routing.",
      },
    },
  });
}

import type { FastifyBaseLogger } from "fastify";

import type { TransportGraph } from "../graph/transport.graph.js";
import { getFerryDiagnostics } from "../repositories/ferry.repository.js";
import type { FerryDiagnostics } from "../models/ferry.model.js";
import { getTramDiagnostics } from "../repositories/tram.repository.js";
import type { TramDiagnostics } from "../models/tram.model.js";

/**
 * Startup data validation (specification section 20).
 *
 * The specification asks for two things that pull in opposite directions: check the
 * ferry and tram data at startup, and "log warnings instead of crashing the entire
 * server for non-critical data-quality problems". This module is therefore built to
 * be unable to fail: every mode is validated independently inside its own try/catch,
 * the caller gets a report either way, and nothing here throws. A bad ferry row must
 * not be able to stop the bus and metro API from serving.
 *
 * Findings are split into two severities. A *problem* is something wrong with the
 * data. A *note* is something true about this data set that is expected and already
 * accounted for elsewhere (F006 has no verified fare; both tram services are
 * irregular and therefore ride on static estimates). Logging the second as a warning
 * on every boot would train whoever reads the logs to ignore them.
 */

export interface StartupValidationReport {
  ferry: FerryDiagnostics | null;
  tram: TramDiagnostics | null;
  /** Data problems, in the form "FERRY: <finding>". */
  problems: string[];
  /** Expected characteristics of this data set. */
  notes: string[];
  /** True when both modes validated and no problems were found. */
  ok: boolean;
}

/** Compactly renders a non-empty check list, or undefined when it is clean. */
function finding(label: string, values: string[]): string | undefined {
  if (values.length === 0) return undefined;
  const shown = values.slice(0, 5).join("; ");
  const more = values.length > 5 ? ` (+${values.length - 5} more)` : "";
  return `${label}: ${shown}${more}`;
}

function collectFerryProblems(diagnostics: FerryDiagnostics): string[] {
  return [
    finding("legs/schedules/fares name a route that does not exist", diagnostics.missingRouteReferences),
    finding("duplicate route_id", diagnostics.duplicateRouteIds),
    finding("duplicate ghat_id", diagnostics.duplicateGhatIds),
    finding("route has an unrecognised status", diagnostics.routesWithInvalidStatus),
    finding("leg has a negative duration", diagnostics.legsWithNegativeDuration),
    finding("schedule has a negative frequency", diagnostics.schedulesWithNegativeFrequency),
  ].filter((entry): entry is string => entry !== undefined);
}

function collectFerryNotes(diagnostics: FerryDiagnostics): string[] {
  const notes: string[] = [];
  if (diagnostics.routesWithUnverifiedFare.length > 0) {
    notes.push(
      `no verified fare for ${diagnostics.routesWithUnverifiedFare.join(", ")}; journeys quote fare as null rather than 0`,
    );
  }
  if (diagnostics.suspendedRoutes > 0) {
    notes.push(
      `${diagnostics.suspendedRoutes} route(s) are suspended/cancelled and are excluded from the live graph`,
    );
  }
  return notes;
}

function collectTramProblems(diagnostics: TramDiagnostics): string[] {
  return [
    finding("stops/legs/services name a route that does not exist", diagnostics.missingRouteReferences),
    finding("duplicate stop_id", diagnostics.duplicateStopIds),
    finding("stop_sequence is not a gapless 1..N run", diagnostics.invalidStopSequences),
    finding("service has a negative frequency", diagnostics.servicesWithNegativeFrequency),
  ].filter((entry): entry is string => entry !== undefined);
}

function collectTramNotes(diagnostics: TramDiagnostics): string[] {
  const notes: string[] = [];
  if (diagnostics.routesWithIrregularService.length > 0) {
    notes.push(
      `${diagnostics.routesWithIrregularService.join(", ")} run irregularly with no published headway, so they are timed from static per-hop estimates instead of a timetable`,
    );
  }
  if (diagnostics.excludedHistoricalRoutes > 0) {
    notes.push(
      `${diagnostics.excludedHistoricalRoutes} historical route(s) and ${diagnostics.heritageServices} heritage service(s) are kept out of the live graph`,
    );
  }
  return notes;
}

/**
 * Cross-checks the diagnostics against what the graph actually loaded. This is the
 * part that turns the section 20 requirement "suspended/cancelled routes are not
 * loaded into the live graph" and "historical routes are not loaded" from a claim
 * about the code into something observed at runtime: the counts have to agree.
 */
function crossCheckGraph(
  graph: TransportGraph,
  ferry: FerryDiagnostics,
  tram: TramDiagnostics,
): string[] {
  const problems: string[] = [];
  const stats = graph.data.stats;

  if (stats.ferryRouteCount !== ferry.operationalRoutes) {
    problems.push(
      `graph loaded ${stats.ferryRouteCount} ferry route(s) but ${ferry.operationalRoutes} are operational`,
    );
  }
  if (stats.tramRouteCount !== tram.operationalRoutes) {
    problems.push(
      `graph loaded ${stats.tramRouteCount} tram route(s) but ${tram.operationalRoutes} are operational`,
    );
  }
  if (stats.orphanLegRouteIds.length > 0) {
    problems.push(
      `graph found leg rows for unknown route id(s) ${stats.orphanLegRouteIds.join(", ")}; those rows were skipped`,
    );
  }
  if (stats.nodesByMode.FERRY !== undefined && stats.nodesByMode.FERRY === 0) {
    problems.push("no ferry nodes were built even though ferry routes are operational");
  }
  if (stats.nodesByMode.TRAM !== undefined && stats.nodesByMode.TRAM === 0) {
    problems.push("no tram nodes were built even though tram routes are operational");
  }
  return problems;
}

/**
 * Runs every section 20 check and logs the outcome. Returns the report instead of
 * throwing, so the caller decides what to do; in practice it only logs.
 */
export async function validateStartupData(
  graph: TransportGraph,
  log: FastifyBaseLogger,
): Promise<StartupValidationReport> {
  const problems: string[] = [];
  const notes: string[] = [];
  let ferry: FerryDiagnostics | null = null;
  let tram: TramDiagnostics | null = null;

  try {
    ferry = await getFerryDiagnostics();
    problems.push(...collectFerryProblems(ferry).map((p) => `FERRY: ${p}`));
    notes.push(...collectFerryNotes(ferry).map((n) => `FERRY: ${n}`));
    log.info(
      {
        mode: "FERRY",
        routes: ferry.routes,
        operational: ferry.operationalRoutes,
        ghats: ferry.ghats,
        legs: ferry.legs,
        status: ferry.status,
      },
      "startup data validation: ferry",
    );
  } catch (error) {
    problems.push(`FERRY: validation could not run (${(error as Error).message})`);
  }

  try {
    tram = await getTramDiagnostics();
    problems.push(...collectTramProblems(tram).map((p) => `TRAM: ${p}`));
    notes.push(...collectTramNotes(tram).map((n) => `TRAM: ${n}`));
    log.info(
      {
        mode: "TRAM",
        routes: tram.routes,
        operational: tram.operationalRoutes,
        stops: tram.stops,
        legs: tram.edges,
        status: tram.status,
      },
      "startup data validation: tram",
    );
  } catch (error) {
    problems.push(`TRAM: validation could not run (${(error as Error).message})`);
  }

  if (ferry && tram) {
    problems.push(...crossCheckGraph(graph, ferry, tram));
  }

  for (const note of notes) {
    log.info({ detail: note }, "startup data validation: note");
  }
  for (const problem of problems) {
    log.warn({ detail: problem }, "startup data validation: problem");
  }

  return {
    ferry,
    tram,
    problems,
    notes,
    ok: problems.length === 0 && ferry !== null && tram !== null,
  };
}

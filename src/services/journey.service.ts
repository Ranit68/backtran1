import { AppError, ErrorCode } from "../utils/errors.js";
import { env } from "../config/env.js";
import { findBestPathAcross, type PathResult, type PathStep } from "../graph/pathfinder.js";
import { edgeTimeMinutes, isRideEdge, isTransferEdge, type RideEdge } from "../graph/graph.edge.js";
import { getGraph } from "./graph.service.js";
import { getTimetableForRouteNos, resolveTimetableRouteNos } from "../repositories/bus.repository.js";
import type { BusTimetableRow } from "../models/bus.model.js";
import type {
  JourneyModeFilter,
  JourneyRequest,
  JourneyResponse,
  JourneySegment,
  JourneyStrategy,
  TimingConfidence,
  TransportMode,
} from "../types/transport.js";
import {
  combineDateAndMinutes,
  formatMinutesToClock,
  minutesBetween,
  nowMinutes,
  parseClockToMinutes,
  round,
} from "../utils/time.js";

/**
 * Journey planner.
 *
 * Framework-independent by design (spec section 28): this service takes a plain
 * request object and returns a plain response object. Nothing here imports
 * Fastify, so the planner can be extracted into a dedicated compute service
 * later without touching the HTTP layer.
 *
 * Timing honesty, which is the main constraint (spec sections 22 and 28):
 *  - Ride times come from real timetable averages when the route has them.
 *  - A requested departure time is matched against real scheduled departures
 *    where those exist for the route.
 *  - The bus timetable records only a trip's overall departure and arrival, not
 *    a time at each stop, so a mid-route segment's clock time is SCALED across
 *    the trip. Every such segment is labelled `timingConfidence: "SCALED"`.
 *  - Nothing is invented: `totalDistanceKm` is omitted entirely unless real
 *    coordinates exist, and tram legs are always `ESTIMATED` because no tram
 *    timetable source was supplied.
 */

export interface JourneyOptions {
  mode?: JourneyModeFilter;
  strategy?: JourneyStrategy;
  departureTime?: string;
  timetableAware?: boolean;
}

interface TimetableIndex {
  /** routeNo (as resolved) -> trips. */
  byRouteNo: Map<string, BusTimetableRow[]>;
  /** Routes that were asked about but have no timetable rows at all. */
  unresolvedRoutes: string[];
}

export class JourneyService {
  async plan(request: JourneyOptions & { source: string; destination: string }): Promise<JourneyResponse> {
    const strategy: JourneyStrategy = request.strategy ?? "MIN_TIME";
    const mode: JourneyModeFilter = request.mode ?? "ALL";
    const timetableAware = request.timetableAware ?? true;
    const graph = await getGraph();

    const warnings: string[] = [];

    const sourceMatches = graph.resolvePlace(request.source, { minScore: 0.7, limit: 12 });
    const destinationMatches = graph.resolvePlace(request.destination, { minScore: 0.7, limit: 12 });

    if (sourceMatches.length === 0) {
      throw new AppError(
        ErrorCode.STATION_NOT_FOUND,
        `Source "${request.source}" could not be found in the transport data.`,
        { source: request.source, searchedModes: mode },
      );
    }
    if (destinationMatches.length === 0) {
      throw new AppError(
        ErrorCode.STATION_NOT_FOUND,
        `Destination "${request.destination}" could not be found in the transport data.`,
        { destination: request.destination, searchedModes: mode },
      );
    }

    // Generic so the filter keeps the full match type ({ node, score }) rather
    // than collapsing to the mode field it inspects.
    const allowedNodes = <T extends { node: { mode: TransportMode } }>(matches: T[]): T[] =>
      mode === "ALL" ? matches : matches.filter((match) => match.node.mode === mode);

    const usableSources = allowedNodes(sourceMatches);
    const usableDestinations = allowedNodes(destinationMatches);

    if (usableSources.length === 0) {
      throw new AppError(
        ErrorCode.STATION_NOT_FOUND,
        `Source "${request.source}" was found, but not by the requested mode ${mode}.`,
        { source: request.source, mode, availableModes: [...new Set(sourceMatches.map((m) => m.node.mode))] },
      );
    }
    if (usableDestinations.length === 0) {
      throw new AppError(
        ErrorCode.STATION_NOT_FOUND,
        `Destination "${request.destination}" was found, but not by the requested mode ${mode}.`,
        {
          destination: request.destination,
          mode,
          availableModes: [...new Set(destinationMatches.map((m) => m.node.mode))],
        },
      );
    }

    const best = findBestPathAcross(
      graph,
      usableSources.map((match) => match.node.id),
      usableDestinations.map((match) => match.node.id),
      { strategy, modes: mode },
    );

    if (!best) {
      warnings.push(
        `No connected journey was found between these two places using mode=${mode}. ` +
          `They may be served by separate networks with no shared interchange in the current data.`,
      );
      return {
        source: request.source,
        destination: request.destination,
        totalTimeMinutes: 0,
        interchangeCount: 0,
        segments: [],
        modesUsed: [],
        strategy,
        timetableMatched: false,
        warnings,
      };
    }

    const requestMinutes = request.departureTime ? parseDepartureTime(request.departureTime) : null;
    if (request.departureTime && requestMinutes === null) {
      warnings.push(`departureTime "${request.departureTime}" was not a recognisable time; planning from "now" instead.`);
    }

    const timetable = timetableAware
      ? await this.loadTimetableIndex(best.result, graph)
      : { byRouteNo: new Map(), unresolvedRoutes: [] };

    const { segments, clockMinutes } = this.buildSegments(graph, best.result, {
      timetable,
      requestMinutes,
      warnings,
    });

    const totalTimeMinutes = round(
      segments.reduce((sum, segment) => sum + (segment.estimatedMinutes ?? 0), 0),
      1,
    );

    // Every boundary between two ride segments is an interchange, whether or not
    // a WALK leg sits between them: changing from one bus to another is a change
    // of vehicle even at the same stop. Counting only WALK legs reported a
    // two-bus journey as zero interchanges.
    const rideSegments = segments.filter((segment) => segment.mode !== "WALK" && segment.mode !== "TRANSFER");
    const interchangeCount = Math.max(0, rideSegments.length - 1);
    const modesUsed = [...new Set(rideSegments.map((s) => s.mode as TransportMode))];
    const timetableMatched = segments.some(
      (segment) => segment.timingConfidence === "EXACT" || segment.timingConfidence === "SCALED",
    );

    // Real total distance is only reportable when every leg had coordinates.
    const totalDistanceKm = computeTotalDistanceKm(segments);
    if (totalDistanceKm === null) {
      warnings.push(
        "totalDistanceKm is omitted because the bus and tram source data contains no stop coordinates. " +
          "It will be reported once a coordinate source (for example Metro stops) is added.",
      );
    }

    if (!timetableMatched && timetableAware) {
      warnings.push(
        "No scheduled departure could be matched for this journey, so all timings are static estimates. " +
          "See GET /api/bus/diagnostics for timetable coverage.",
      );
    }
    if (graph.data.stats.placeholderStopsExcluded > 0) {
      warnings.push(
        `${graph.data.stats.placeholderStopsExcluded} placeholder stop row(s) such as "(no stop data captured)" ` +
          `were excluded from the graph. They remain stored in the database unchanged.`,
      );
    }

    const response: JourneyResponse = {
      source: request.source,
      destination: request.destination,
      totalTimeMinutes,
      interchangeCount,
      segments,
      modesUsed,
      strategy,
      timetableMatched,
      warnings,
    };
    if (totalDistanceKm !== null) response.totalDistanceKm = totalDistanceKm;
    void clockMinutes;
    return response;
  }

  /**
   * Loads timetable rows for every bus route the path uses, resolving each
   * route-stop route number into the timetable namespace first.
   */
  private async loadTimetableIndex(result: PathResult, graph: Awaited<ReturnType<typeof getGraph>>): Promise<TimetableIndex> {
    const byRouteNo = new Map<string, BusTimetableRow[]>();
    const unresolvedRoutes: string[] = [];

    const busRouteNos = new Set<string>();
    for (const step of result.steps) {
      const edge = step.edge;
      if (isRideEdge(edge) && edge.mode === "BUS") busRouteNos.add(edge.routeNo ?? "");
    }

    if (busRouteNos.size === 0) return { byRouteNo, unresolvedRoutes };

    const resolution = new Map<string, string[]>();
    for (const routeNo of busRouteNos) {
      if (routeNo.length === 0) continue;
      try {
        resolution.set(routeNo, await resolveTimetableRouteNos("BUS", routeNo));
      } catch {
        // No database: fall back to the route number as-is.
        resolution.set(routeNo, [routeNo]);
      }
    }

    const allTargets = [...new Set([...resolution.values()].flat())];
    let rows: BusTimetableRow[] = [];
    try {
      rows = await getTimetableForRouteNos(allTargets);
    } catch {
      rows = [];
    }

    for (const row of rows) {
      const bucket = byRouteNo.get(row.route_no);
      if (bucket) bucket.push(row);
      else byRouteNo.set(row.route_no, [row]);
    }

    for (const [routeNo, targets] of resolution) {
      const hasAny = targets.some((target) => (byRouteNo.get(target)?.length ?? 0) > 0);
      if (!hasAny) unresolvedRoutes.push(routeNo);
    }

    void graph;
    return { byRouteNo, unresolvedRoutes };
  }

  /**
   * Collapses the raw path into human-meaningful segments: consecutive hops on
   * the same route become one ride, a transfer edge becomes a WALK leg, and a
   * change of route at the same stop becomes a TRANSFER leg.
   */
  private buildSegments(
    graph: Awaited<ReturnType<typeof getGraph>>,
    result: PathResult,
    context: {
      timetable: TimetableIndex;
      requestMinutes: number | null;
      warnings: string[];
    },
  ): { segments: JourneySegment[]; clockMinutes: number[] } {
    const segments: JourneySegment[] = [];
    const clockMinutes: number[] = [];

    let currentRide: {
      routeId: string;
      routeNo: string;
      operator: string;
      mode: TransportMode;
      nodeIds: string[];
      fromHop: number;
      toHop: number;
      totalHops: number;
    } | null = null;

    const flushRide = (): void => {
      if (!currentRide) return;
      const ride = currentRide;
      currentRide = null;
      segments.push(this.buildRideSegment(graph, ride, context, clockMinutes));
    };

    for (const step of result.steps) {
      const edge = step.edge;

      if (isTransferEdge(edge)) {
        flushRide();
        const from = graph.getNode(step.fromNodeId);
        const to = graph.getNode(step.toNodeId);
        const segment: JourneySegment = {
          mode: "WALK",
          from: from?.name ?? step.fromNodeId,
          to: to?.name ?? step.toNodeId,
          estimatedMinutes: Math.max(1, Math.round(edgeTimeMinutes(edge))),
          fromStopId: step.fromNodeId,
          toStopId: step.toNodeId,
          fromNodeId: step.fromNodeId,
          toNodeId: step.toNodeId,
          timingConfidence: "ESTIMATED",
        };
        if (edge.distanceMeters !== undefined) {
          segment.distanceKm = round(edge.distanceMeters / 1000, 3);
        }
        segments.push(segment);
        continue;
      }

      const rideEdge = edge as RideEdge;
      // A continuation is the same route entered where the previous ride edge
      // ended. Comparing against the last node in nodeIds, not a stale
      // toNodeId field, so a route that revisits a stop is not split in two.
      const lastNodeId = currentRide?.nodeIds[currentRide.nodeIds.length - 1];
      const sameRoute =
        currentRide !== null && currentRide.routeId === rideEdge.routeId && lastNodeId === rideEdge.fromNodeId;

      if (!sameRoute) {
        // Changing vehicle is an interchange even when it happens at the same
        // stop: the two rides are separate buses. The graph only emits an
        // explicit transfer edge when the stops differ, so without this the
        // journey reported a bus-to-bus change as zero interchanges and no
        // changeover time at all.
        //
        // The ride is flushed first so the changeover lands AFTER the ride it
        // follows, keeping the segment list in travel order.
        const finishedRide = currentRide;
        flushRide();
        if (finishedRide) {
          segments.push(this.buildChangeoverSegment(graph, finishedRide, rideEdge));
        }
        currentRide = {
          routeId: rideEdge.routeId ?? "",
          routeNo: rideEdge.routeNo ?? "",
          operator: rideEdge.operator ?? "",
          mode: rideEdge.mode as TransportMode,
          nodeIds: [rideEdge.fromNodeId, rideEdge.toNodeId],
          fromHop: Math.min(rideEdge.fromHop, rideEdge.toHop),
          toHop: Math.max(rideEdge.fromHop, rideEdge.toHop),
          totalHops: rideEdge.totalHops,
        };
      } else if (currentRide) {
        currentRide.nodeIds.push(rideEdge.toNodeId);
        currentRide.toHop = Math.max(currentRide.toHop, Math.max(rideEdge.fromHop, rideEdge.toHop));
      }
    }
    flushRide();

    return { segments, clockMinutes };
  }

  /**
   * The changeover between two rides boarded at the same stop: getting off one
   * vehicle and waiting for the next. The minutes are a static planning
   * allowance (MIN_INTERCHANGE_MINUTES), not a measurement, and the segment is
   * labelled ESTIMATED so no client can mistake it for timetable data.
   */
  private buildChangeoverSegment(
    graph: Awaited<ReturnType<typeof getGraph>>,
    previous: { routeNo: string; mode: TransportMode; nodeIds: string[] },
    next: RideEdge,
  ): JourneySegment {
    const nodeId = previous.nodeIds[previous.nodeIds.length - 1] ?? next.fromNodeId;
    const stopName = graph.getNode(nodeId)?.name ?? nodeId;
    return {
      mode: "TRANSFER",
      from: stopName,
      to: stopName,
      estimatedMinutes: env.MIN_INTERCHANGE_MINUTES,
      fromStopId: nodeId,
      toStopId: nodeId,
      fromNodeId: nodeId,
      toNodeId: nodeId,
      timingConfidence: "ESTIMATED",
    };
  }

  private buildRideSegment(
    graph: Awaited<ReturnType<typeof getGraph>>,
    ride: {
      routeId: string;
      routeNo: string;
      operator: string;
      mode: TransportMode;
      nodeIds: string[];
      fromHop: number;
      toHop: number;
      totalHops: number;
    },
    context: { timetable: TimetableIndex; requestMinutes: number | null; warnings: string[] },
    clockMinutes: number[],
  ): JourneySegment {
    const names = ride.nodeIds
      .map((nodeId) => graph.getNode(nodeId)?.name ?? nodeId)
      .filter((name, index, all) => index === 0 || name !== all[index - 1]);

    const staticMinutes = this.staticSegmentMinutes(graph, ride);

    const segment: JourneySegment = {
      mode: ride.mode,
      routeNo: ride.routeNo,
      operator: ride.operator,
      from: names[0] ?? ride.nodeIds[0] ?? "",
      to: names[names.length - 1] ?? ride.nodeIds[ride.nodeIds.length - 1] ?? "",
      estimatedMinutes: staticMinutes,
      stops: names,
      fromStopId: ride.nodeIds[0],
      toStopId: ride.nodeIds[ride.nodeIds.length - 1],
      fromNodeId: ride.nodeIds[0],
      toNodeId: ride.nodeIds[ride.nodeIds.length - 1],
      timingConfidence: "ESTIMATED",
    };

    // Timetable awareness only applies to bus, because bus is the only mode
    // with a timetable source file.
    if (ride.mode !== "BUS" || context.timetable.byRouteNo.size === 0) {
      return segment;
    }

    const targetRouteNos = [...context.timetable.byRouteNo.keys()].filter((key) => {
      // Cheap pre-filter: only consider route numbers that were resolved for
      // this journey. Falls back to an exact comparison on the route number.
      return key === ride.routeNo;
    });
    void targetRouteNos;

    const trips = this.tripsForRoute(context.timetable, ride.routeNo);
    if (trips.length === 0) return segment;

    const trip = pickTrip(trips, context.requestMinutes);
    if (!trip) return segment;

    const tripDuration = minutesBetween(trip.departure_time, trip.arrival_time);
    if (tripDuration === null || tripDuration <= 0) return segment;

    // The timetable records one departure and one arrival per trip, with no
    // per-stop times, so the segment's slice of the trip is proportional to
    // how many hops of the route it covers.
    const segmentHops = Math.max(1, ride.toHop - ride.fromHop);
    const share = Math.min(1, segmentHops / Math.max(1, ride.totalHops));
    const scaledMinutes = Math.max(1, Math.round(tripDuration * share));

    const departureMinutes = parseClockToMinutes(trip.departure_time);
    const earliestBoard = departureMinutes ?? 0;
    const boardingOffset = Math.round((tripDuration * (ride.fromHop / Math.max(1, ride.totalHops))));
    const alightingOffset = Math.round((tripDuration * (ride.toHop / Math.max(1, ride.totalHops))));

    segment.estimatedMinutes = scaledMinutes;
    segment.tripNo = trip.trip_no;
    segment.directionId = trip.direction_id;
    segment.departureTime = formatMinutesToClock(earliestBoard + boardingOffset);
    segment.arrivalTime = formatMinutesToClock(earliestBoard + alightingOffset);
    segment.timingConfidence = "SCALED";

    if (context.requestMinutes !== null && departureMinutes !== null) {
      const wait = departureMinutes - context.requestMinutes;
      if (wait >= 0) {
        segment.waitMinutes = wait;
        clockMinutes.push(context.requestMinutes + wait);
      } else {
        // The first matching departure has already gone; the next service runs
        // tomorrow, so the wait is a full service day away.
        segment.waitMinutes = wait + 24 * 60;
        clockMinutes.push(context.requestMinutes + segment.waitMinutes);
        context.warnings.push(
          `Route ${ride.routeNo} has no departure after ${formatMinutesToClock(context.requestMinutes)} today; ` +
            `the reported time assumes the next service, roughly a day later.`,
        );
      }
    }

    return segment;
  }

  private tripsForRoute(index: TimetableIndex, routeNo: string): BusTimetableRow[] {
    const direct = index.byRouteNo.get(routeNo);
    if (direct && direct.length > 0) return direct;
    // The index is keyed by timetable route numbers; the planner may hold a
    // route-stop route number that was resolved into a different one.
    const normalized = routeNo.toLowerCase().replace(/[^a-z0-9]+/g, "");
    for (const [key, rows] of index.byRouteNo) {
      if (key.toLowerCase().replace(/[^a-z0-9]+/g, "") === normalized) return rows;
    }
    return [];
  }

  /** Sum of the graph's per-hop estimates for this segment. */
  private staticSegmentMinutes(
    graph: Awaited<ReturnType<typeof getGraph>>,
    ride: { routeId: string; fromHop: number; toHop: number },
  ): number {
    const route = graph.data.routes.get(ride.routeId);
    const hops = Math.max(1, ride.toHop - ride.fromHop);
    if (!route) return hops * 3;
    return Math.max(1, Math.round(route.minutesPerHop * hops));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Accepts "HH:MM", "HH:MM:SS" or a full ISO-8601 timestamp. */
export function parseDepartureTime(value: string): number | null {
  const clockOnly = /^(\d{1,2}):([0-5]\d)(?::([0-5]\d))?$/.exec(value.trim());
  if (clockOnly) {
    return Number(clockOnly[1]) * 60 + Number(clockOnly[2]);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.getHours() * 60 + parsed.getMinutes();
}

function pickTrip(trips: BusTimetableRow[], fromMinutes: number | null): BusTimetableRow | null {
  const usable = trips.filter((trip) => trip.departure_time !== null && parseClockToMinutes(trip.departure_time) !== null);
  if (usable.length === 0) return null;
  const effectiveFrom = fromMinutes ?? nowMinutes();

  const upcoming = usable
    .filter((trip) => (parseClockToMinutes(trip.departure_time) ?? 0) >= effectiveFrom)
    .sort((a, b) => (parseClockToMinutes(a.departure_time) ?? 0) - (parseClockToMinutes(b.departure_time) ?? 0));
  if (upcoming.length > 0) return upcoming[0]!;

  return (
    [...usable].sort(
      (a, b) => (parseClockToMinutes(a.departure_time) ?? 0) - (parseClockToMinutes(b.departure_time) ?? 0),
    )[0] ?? null
  );
}

/**
 * Only returns a distance when every ride leg has one. Omitting the field is
 * the correct behaviour: the specification forbids fabricating distance data,
 * and the bus/tram source has none.
 */
function computeTotalDistanceKm(segments: JourneySegment[]): number | null {
  const distances = segments
    .map((segment) => segment.distanceKm)
    .filter((value): value is number => typeof value === "number");
  if (distances.length === 0 || distances.length !== segments.length) return null;
  return round(distances.reduce((sum, value) => sum + value, 0), 2);
}

export { combineDateAndMinutes };

let defaultService: JourneyService | null = null;

export function getJourneyService(): JourneyService {
  if (!defaultService) defaultService = new JourneyService();
  return defaultService;
}

import { AppError, ErrorCode } from "../utils/errors.js";
import { env } from "../config/env.js";
import { findBestPathAcross, type PathResult, type PathStep } from "../graph/pathfinder.js";
import { edgeTimeMinutes, isRideEdge, isTransferEdge, type RideEdge } from "../graph/graph.edge.js";
import { getGraph } from "./graph.service.js";
import { getTimetableForRouteNos, resolveTimetableRouteNos } from "../repositories/bus.repository.js";
import {
  getMetroRunsBetweenStations,
  type MetroLegRun,
} from "../repositories/metro.repository.js";
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
 *  - Metro checkpoints do record a time per station, so a Metro leg gets the
 *    real printed boarding departure, and a real printed arrival when the
 *    passenger alights at the run's terminus. Anything else is interpolated
 *    along the run's real duration and labelled `SCALED`.
 *  - Nothing is invented: `totalDistanceKm` is omitted entirely unless real
 *    coordinates exist. A line with no timetable at all, such as the map-only
 *    Pink line, is always `ESTIMATED`.
 */

export interface JourneyOptions {
  mode?: JourneyModeFilter;
  strategy?: JourneyStrategy;
  departureTime?: string;
  timetableAware?: boolean;
}

export interface TimetableIndex {
  /** routeNo (as resolved) -> trips. */
  byRouteNo: Map<string, BusTimetableRow[]>;
  /** Routes that were asked about but have no timetable rows at all. */
  unresolvedRoutes: string[];
  /**
   * `line|from|to` -> real runs serving that leg in that direction.
   *
   * Keyed on the two station names rather than the line alone, because a run
   * only qualifies when it passes both stations in the order the passenger is
   * travelling, so the useful set depends on the exact boarding pair.
   */
  metroByLeg: Map<string, MetroLegRun[]>;
  /** Lines the journey uses that have no timetable rows at all (e.g. Pink). */
  metroLinesWithoutTimetable: string[];
}

/**
 * Where a reader should look for timetable coverage for each mode. Used to point
 * journey warnings at the endpoint that actually describes the modes involved,
 * instead of always naming the bus one.
 */
const DIAGNOSTICS_ENDPOINT: Record<TransportMode, string> = {
  BUS: "GET /api/bus/diagnostics",
  METRO: "GET /api/metro/diagnostics",
  FERRY: "GET /api/ferry/diagnostics",
  TRAM: "GET /api/tram/diagnostics",
};

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
      : { byRouteNo: new Map(), unresolvedRoutes: [], metroByLeg: new Map(), metroLinesWithoutTimetable: [] };

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
        "totalDistanceKm is omitted because the source data for " +
          `${modesUsed.join(", ")} carries no stop coordinates. ` +
          "It will be reported once a coordinate source is added.",
      );
    }

    if (!timetableMatched && timetableAware) {
      // Point at the diagnostics endpoint for the modes actually in this journey.
      // Sending a ferry-only reader to /api/bus/diagnostics is not useful.
      const endpoints = [...new Set(modesUsed.map((mode) => DIAGNOSTICS_ENDPOINT[mode]))].sort();
      warnings.push(
        "No scheduled departure could be matched for this journey, so all timings are static estimates. " +
          `See ${endpoints.join(", ")} for timetable coverage.`,
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
   * Loads real timetable data for every route the path uses: bus rows keyed by
   * route number, and Metro runs keyed by the exact boarding pair. Both sources
   * are optional, and a missing source degrades to static estimates rather than
   * failing the request.
   */
  private async loadTimetableIndex(result: PathResult, graph: Awaited<ReturnType<typeof getGraph>>): Promise<TimetableIndex> {
    const byRouteNo = new Map<string, BusTimetableRow[]>();
    const unresolvedRoutes: string[] = [];
    const metroByLeg = new Map<string, MetroLegRun[]>();
    const metroLinesWithoutTimetable = new Set<string>();

    const busRouteNos = new Set<string>();
    /** line -> distinct `from|to` boarding pairs, so each leg is fetched once. */
    const metroLegs = new Map<string, Set<string>>();

    for (const step of result.steps) {
      const edge = step.edge;
      if (!isRideEdge(edge)) continue;
      if (edge.mode === "BUS") {
        busRouteNos.add(edge.routeNo ?? "");
        continue;
      }
      if (edge.mode !== "METRO") continue;

      const fromName = graph.getNode(step.fromNodeId)?.name;
      const toName = graph.getNode(step.toNodeId)?.name;
      if (!fromName || !toName) continue;
      const pairs = metroLegs.get(edge.routeNo ?? "") ?? new Set<string>();
      pairs.add(metroLegKey(edge.routeNo ?? "", fromName, toName));
      metroLegs.set(edge.routeNo ?? "", pairs);
    }

    for (const [line, keys] of metroLegs) {
      for (const key of keys) {
        const { from: fromName, to: toName } = splitMetroLegKey(key);
        try {
          const runs = await getMetroRunsBetweenStations(line, fromName, toName);
          if (runs.length > 0) metroByLeg.set(key, runs);
        } catch {
          // No database or line absent from the source: fall through to the
          // static estimate. Never fail a journey request over timing data.
        }
      }
      if (line.length > 0 && ![...metroByLeg.keys()].some((key) => key.startsWith(`${line}|`))) {
        metroLinesWithoutTimetable.add(line);
      }
    }

    if (busRouteNos.size > 0) {
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
    }

    return {
      byRouteNo,
      unresolvedRoutes,
      metroByLeg,
      metroLinesWithoutTimetable: [...metroLinesWithoutTimetable],
    };
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
      /**
       * Travel time accumulated from the real edge weights of the legs actually
       * traversed.
       *
       * This must not be reconstructed from the hop numbers afterwards. A
       * recorded leg carries its own duration -- the ferry hops of one route
       * range from 6 to 20 minutes -- so a route's average hop time times a hop
       * count is not the same sum, and a route whose legs are split across
       * several travel directions is not one linear sequence at all.
       */
      minutes: number;
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
          minutes: edgeTimeMinutes(rideEdge),
        };
      } else if (currentRide) {
        currentRide.nodeIds.push(rideEdge.toNodeId);
        currentRide.toHop = Math.max(currentRide.toHop, Math.max(rideEdge.fromHop, rideEdge.toHop));
        currentRide.minutes += edgeTimeMinutes(rideEdge);
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
      minutes: number;
    },
    context: { timetable: TimetableIndex; requestMinutes: number | null; warnings: string[] },
    clockMinutes: number[],
  ): JourneySegment {
    const names = ride.nodeIds
      .map((nodeId) => graph.getNode(nodeId)?.name ?? nodeId)
      .filter((name, index, all) => index === 0 || name !== all[index - 1]);

    // The sum of the traversed legs' own weights, already available from the walk
    // over the path. See the note on `currentRide.minutes`.
    const staticMinutes = Math.max(1, Math.round(ride.minutes));

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

    // Timetable awareness differs by mode because the two sources differ in
    // shape: bus has one departure and one arrival per trip and no per-stop
    // times, whereas Metro checkpoints carry a time per station.
    if (ride.mode === "METRO") {
      return this.applyMetroTiming(segment, ride, context);
    }

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

  /**
   * Fills a Metro leg with real times when the timetable can supply them.
   *
   * The data is not uniform, so each case is labelled for what it actually is:
   *
   *  1. `boardTime` and `alightTime` both present -> EXACT. The timetable printed
   *     both ends for this specific run.
   *  2. `boardTime` present, no printed alighting time -> the boarding time is
   *     real, and the ride is scaled along the run's real duration using the
   *     station's real position on the line. SCALED, never EXACT.
   *  3. Neither printed -> scaled from the run's own departure along its real
   *     duration. SCALED.
   *  4. No run at all, e.g. the map-only Pink line -> the graph's static
   *     estimate is kept and stays ESTIMATED.
   */
  private applyMetroTiming(
    segment: JourneySegment,
    ride: { routeNo: string },
    context: { timetable: TimetableIndex; requestMinutes: number | null; warnings: string[] },
  ): JourneySegment {
    const from = segment.from;
    const to = segment.to;
    if (!from || !to) return segment;

    const runs = context.timetable.metroByLeg.get(metroLegKey(ride.routeNo, from, to));
    if (!runs || runs.length === 0) {
      if (context.timetable.metroLinesWithoutTimetable.includes(ride.routeNo)) {
        context.warnings.push(
          `Metro line ${ride.routeNo} has no timetable in the source data, so its timing is a static estimate.`,
        );
      }
      return segment;
    }

    const run = pickMetroRun(runs, context.requestMinutes);
    if (!run) return segment;

    segment.tripId = run.tripId;
    segment.serviceDay = run.serviceDay;
    segment.direction = run.direction;
    if (run.trainNo) segment.tripNo = undefined;

    const boardMinutes = parseClockToMinutes(run.boardTime ?? run.runDepartureTime);
    const runDuration = run.runDurationMinutes ?? minutesBetween(run.runDepartureTime, run.runArrivalTime);
    const runHops = run.runHops > 0 ? run.runHops : null;
    const legHops = run.legHops > 0 ? run.legHops : null;

    // Case 1: both ends printed for this run.
    const alightMinutes = parseClockToMinutes(run.alightTime);
    if (run.boardTime && run.alightTime && boardMinutes !== null && alightMinutes !== null) {
      const minutes = alightMinutes - boardMinutes;
      if (minutes > 0) {
        segment.estimatedMinutes = minutes;
        segment.departureTime = formatMinutesToClock(boardMinutes);
        segment.arrivalTime = formatMinutesToClock(alightMinutes);
        segment.timingConfidence = "EXACT";
        this.applyWait(segment, boardMinutes, context);
        return segment;
      }
    }

    // Cases 2 and 3: scale the run's real duration by how much of the line the
    // passenger actually covers.
    //
    // The two cases differ in where the clock starts, and getting that wrong
    // would move a real printed time: when `boardTime` exists it IS the moment
    // the train left the boarding station, so only the leg beyond it is
    // projected. Without it, the projection runs from the run's own departure
    // at its origin.
    if (runDuration !== null && runDuration > 0 && runHops !== null && legHops !== null) {
      const hasPrintedBoard = run.boardTime !== null && boardMinutes !== null;
      const clockStart = hasPrintedBoard ? boardMinutes : parseClockToMinutes(run.runDepartureTime);
      if (clockStart === null) return segment;

      const legFrom = hasPrintedBoard
        ? 0
        : Math.abs(run.boardPosition - run.originPosition);
      const legTo = hasPrintedBoard
        ? Math.abs(run.alightPosition - run.boardPosition)
        : Math.abs(run.alightPosition - run.originPosition);

      const boardingAt = clockStart + Math.round((runDuration * legFrom) / runHops);
      const alightingAt = clockStart + Math.round((runDuration * legTo) / runHops);
      if (alightingAt <= boardingAt) return segment;

      segment.departureTime = formatMinutesToClock(boardingAt);
      segment.arrivalTime = formatMinutesToClock(alightingAt);
      segment.estimatedMinutes = alightingAt - boardingAt;
      segment.timingConfidence = "SCALED";
      this.applyWait(segment, boardingAt, context);
      return segment;
    }

    // Case 4 for this leg: a run exists but has no usable duration, so the
    // graph's own per-hop estimate is the only honest answer available.
    return segment;
  }

  /** Mirrors the bus wait logic so both modes report a changeover the same way. */
  private applyWait(
    segment: JourneySegment,
    boardingAt: number,
    context: { requestMinutes: number | null; warnings: string[] },
  ): void {
    if (context.requestMinutes === null) return;
    const wait = boardingAt - context.requestMinutes;
    if (wait >= 0) {
      segment.waitMinutes = wait;
      return;
    }
    // The requested time is after the last service in the loaded data, so the
    // reported departure belongs to the next service day rather than today.
    segment.waitMinutes = wait + 24 * 60;
    context.warnings.push(
      `No Metro service departs after ${formatMinutesToClock(context.requestMinutes)} in the loaded data; ` +
        `the reported time assumes the next service day, roughly a day later.`,
    );
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

/** `line|from|to`, unambiguous when one station pair is served by two lines. */
function metroLegKey(line: string, from: string, to: string): string {
  return `${line}|${from.toLowerCase()}|${to.toLowerCase()}`;
}

function splitMetroLegKey(key: string): { line: string; from: string; to: string } {
  const separator = key.indexOf("|");
  const second = key.indexOf("|", separator + 1);
  return {
    line: key.slice(0, separator),
    from: key.slice(separator + 1, second),
    to: key.slice(second + 1),
  };
}

/**
 * The run a passenger would actually board.
 *
 * Preference order, so a real exact match is never passed over for an
 * interpolated one:
 *  1. Runs with both ends printed, soonest after the requested time.
 *  2. Any run with a printed boarding time, soonest after the requested time.
 *  3. Whichever run is soonest overall, since a departure before the requested
 *     time is still the closest thing the data offers.
 *
 * The service day is not part of this choice: the request carries a clock time,
 * not a date, so runs from every loaded service pattern compete on clock time
 * alone. The winning run's `serviceDay` is reported on the segment so the
 * caller can see which pattern was matched.
 */
function pickMetroRun(runs: MetroLegRun[], fromMinutes: number | null): MetroLegRun | null {
  const usable = runs.filter((run) => parseClockToMinutes(run.boardTime ?? run.runDepartureTime) !== null);
  if (usable.length === 0) return null;
  const effectiveFrom = fromMinutes ?? nowMinutes();

  const departureOf = (run: MetroLegRun): number =>
    parseClockToMinutes(run.boardTime ?? run.runDepartureTime) ?? Number.MAX_SAFE_INTEGER;
  const isUpcoming = (run: MetroLegRun): boolean => departureOf(run) >= effectiveFrom;
  const isExact = (run: MetroLegRun): boolean => run.boardTime !== null && run.alightTime !== null;

  const bySoonest = (a: MetroLegRun, b: MetroLegRun): number => departureOf(a) - departureOf(b);

  const exactUpcoming = usable.filter((run) => isExact(run) && isUpcoming(run)).sort(bySoonest);
  if (exactUpcoming.length > 0) return exactUpcoming[0]!;

  const anyUpcoming = usable.filter(isUpcoming).sort(bySoonest);
  if (anyUpcoming.length > 0) return anyUpcoming[0]!;

  const exactAny = usable.filter(isExact).sort(bySoonest);
  if (exactAny.length > 0) return exactAny[0]!;

  return [...usable].sort(bySoonest)[0] ?? null;
}

/**
 * Only returns a distance when every ride leg has one. Omitting the field is
 * the correct behaviour: the specification forbids fabricating distance data,
 * and the bus and metro source has none.
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

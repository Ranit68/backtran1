import {
  countBusRoutes,
  countBusTimetableByRouteNos,
  getBusDiagnostics,
  getBusRoute,
  getBusRouteStops,
  getBusTimetableByRouteNos,
  listBusRoutes,
  listBusTimetableRoutes,
  resolveTimetableRouteNos,
  type BusDiagnostics,
  type BusRouteListFilter,
} from "../repositories/bus.repository.js";
import type {
  BusRouteDetail,
  BusRouteStopView,
  BusRouteSummary,
  BusTripView,
} from "../models/bus.model.js";
import type { BusTimetableRow } from "../models/bus.model.js";
import type { PagedData } from "../types/transport.js";
import { AppError, ErrorCode } from "../utils/errors.js";
import { buildRouteNodeId, normalizeStopName } from "../utils/normalize.js";
import { minutesBetween, round } from "../utils/time.js";
import { requireDatabase } from "../repositories/base.repository.js";

/**
 * Bus use cases.
 *
 * The service owns two responsibilities the repository does not: mapping rows
 * to the API view models, and bridging the two bus route-number namespaces.
 */

export class BusService {
  async listRoutes(filter: BusRouteListFilter): Promise<PagedData<BusRouteSummary>> {
    requireDatabase();
    const [rows, total] = await Promise.all([
      listBusRoutes(filter),
      countBusRoutes({ operator: filter.operator, q: filter.q }),
    ]);

    const items = rows.map((row) => this.toSummary(row));
    return {
      items,
      page: {
        total,
        limit: filter.limit,
        offset: filter.offset,
        returned: items.length,
        hasMore: filter.offset + items.length < total,
      },
    };
  }

  /**
   * Route detail including its ordered stops.
   *
   * A route number is looked up as stored, and then as a normalised form, so
   * "C-11" and "C 11" both resolve. Spec section 19 requires route numbers to
   * stay text, which is why matching is a string comparison and not numeric.
   */
  async getRoute(routeNo: string, operator?: string): Promise<BusRouteDetail> {
    requireDatabase();

    let aggregate = await getBusRoute(routeNo, operator);
    if (!aggregate) {
      // Fall back to a normalised comparison, e.g. "C 11" -> "C-11".
      const all = await listBusRoutes({ limit: 500, offset: 0, operator });
      const target = routeNo.toLowerCase().replace(/[^a-z0-9]+/g, "");
      aggregate =
        all.find((candidate) => candidate.route_no.toLowerCase().replace(/[^a-z0-9]+/g, "") === target) ?? null;
    }

    if (!aggregate) {
      throw new AppError(ErrorCode.ROUTE_NOT_FOUND, `Bus route "${routeNo}" was not found.`, { routeNo });
    }

    const stops = await getBusRouteStops(aggregate.route_no, aggregate.operator);
    return {
      ...this.toSummary(aggregate),
      stops: stops.map((row) => this.toStopView(row.stop_name, row.stop_sequence_no, row.depot, row.id)),
    };
  }

  /**
   * Stops for a route number, together with the route's CANONICAL identity.
   *
   * The caller usually passed a loose number ("ac3", "c 11"); echoing that back
   * would hand the client an identifier the database does not contain, so the
   * resolved routeNo/operator are returned instead of the raw request.
   */
  async getRouteStops(
    routeNo: string,
    operator?: string,
  ): Promise<{ routeNo: string; operator: string; mode: "BUS"; stops: BusRouteStopView[] }> {
    const detail = await this.getRoute(routeNo, operator);
    return { routeNo: detail.routeNo, operator: detail.operator, mode: "BUS", stops: detail.stops };
  }

  /**
   * Timetable for a route number from either namespace.
   *
   * Resolves "C-11" (route-stop namespace) to whatever timetable route numbers
   * are known to describe the same service, and also accepts a timetable route
   * number directly, so GET /api/bus/routes/11A/timetable works too.
   */
  async getTimetable(
    routeNo: string,
    options: { operator?: string; directionId?: number; fromMinutes?: number; limit: number; offset: number },
  ): Promise<PagedData<BusTripView> & { requestedRouteNo: string; resolvedRouteNos: string[] }> {
    requireDatabase();

    const routeNos = new Set<string>([routeNo]);
    try {
      for (const resolved of await resolveTimetableRouteNos("BUS", routeNo)) routeNos.add(resolved);
    } catch {
      // Keep the raw route number; the query below will simply return nothing.
    }

    const list = [...routeNos];
    const [rows, total] = await Promise.all([
      getBusTimetableByRouteNos(list, options),
      countBusTimetableByRouteNos(list, options),
    ]);

    return {
      items: rows.map((row) => this.toTripView(row)),
      page: {
        total,
        limit: options.limit,
        offset: options.offset,
        returned: rows.length,
        hasMore: options.offset + rows.length < total,
      },
      requestedRouteNo: routeNo,
      resolvedRouteNos: list,
    };
  }

  /** Every route number that has timetable rows, for the "which routes are timed" view. */
  async listTimetableRoutes(): Promise<{ route_no: string; operator: string | null; trip_count: number }[]> {
    requireDatabase();
    return listBusTimetableRoutes();
  }

  async diagnostics(): Promise<BusDiagnostics> {
    return getBusDiagnostics();
  }

  /** Aggregates the repository row into the public route summary. */
  private toSummary(row: {
    operator: string;
    route_no: string;
    stop_count: number;
    first_stop: string | null;
    last_stop: string | null;
    depot: string | null;
    timetable_count: number;
    avg_trip_minutes: number | null;
  }): BusRouteSummary {
    return {
      routeId: buildRouteNodeId("BUS", row.operator, row.route_no),
      routeNo: row.route_no,
      mode: "BUS",
      operator: row.operator,
      vehicleType: "bus",
      depot: row.depot,
      stopCount: row.stop_count,
      firstStop: row.first_stop,
      lastStop: row.last_stop,
      // Null is meaningful: it means "no real measured trip duration exists for
      // this route". The API omits the estimate rather than inventing one.
      averageTripMinutes: row.avg_trip_minutes === null ? null : round(row.avg_trip_minutes, 1),
      hasTimetable: row.timetable_count > 0,
    };
  }

  private toStopView(
    stopName: string,
    sequence: number,
    depot: string | null,
    id: string,
  ): BusRouteStopView {
    return {
      id,
      stopName,
      stopSequenceNo: sequence,
      depot,
      normalizedName: normalizeStopName(stopName),
    };
  }

  private toTripView(row: BusTimetableRow): BusTripView {
    const duration = minutesBetween(row.departure_time, row.arrival_time);
    return {
      id: row.id,
      // Spec section 20: the timetable's own operator (CSTC) is reported as-is.
      operator: row.operator,
      routeNo: row.route_no,
      tripNo: row.trip_no,
      directionId: row.direction_id,
      origin: row.origin,
      destination: row.destination,
      departureTime: row.departure_time ? row.departure_time.slice(0, 5) : null,
      arrivalTime: row.arrival_time ? row.arrival_time.slice(0, 5) : null,
      durationMinutes: duration === null ? null : duration,
      sourceImageOrder: row.source_image_order,
    };
  }
}

let instance: BusService | null = null;
export function getBusService(): BusService {
  if (!instance) instance = new BusService();
  return instance;
}

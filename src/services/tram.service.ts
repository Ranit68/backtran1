import {
  countTramRoutes,
  getTramRoute,
  getTramRouteStops,
  listTramRoutes,
  type TramRouteAggregate,
  type TramRouteListFilter,
} from "../repositories/tram.repository.js";
import type { TramRouteDetail, TramRouteStopView, TramRouteSummary } from "../models/tram.model.js";
import type { PagedData } from "../types/transport.js";
import { AppError, ErrorCode } from "../utils/errors.js";
import { buildRouteNodeId, normalizeStopName } from "../utils/normalize.js";
import { requireDatabase } from "../repositories/base.repository.js";

/**
 * Tram use cases.
 *
 * No tram timetable source file was supplied (spec section 7), so there is no
 * timetable method and `hasTimetable` is always false. Route detail flags
 * `fullySequenced` so a client can tell a route whose stop order came from the
 * source sequence apart from one where the source omitted sequences.
 */
export class TramService {
  async listRoutes(filter: TramRouteListFilter): Promise<PagedData<TramRouteSummary>> {
    requireDatabase();
    const [rows, total] = await Promise.all([
      listTramRoutes(filter),
      countTramRoutes({ operator: filter.operator, q: filter.q }),
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

  async getRoute(routeNo: string, operator?: string): Promise<TramRouteDetail> {
    requireDatabase();

    let aggregate = await getTramRoute(routeNo, operator);
    if (!aggregate) {
      const all = await listTramRoutes({ limit: 500, offset: 0, operator });
      const target = routeNo.toLowerCase().replace(/[^a-z0-9]+/g, "");
      aggregate =
        all.find((candidate) => candidate.route_no.toLowerCase().replace(/[^a-z0-9]+/g, "") === target) ?? null;
    }

    if (!aggregate) {
      throw new AppError(ErrorCode.ROUTE_NOT_FOUND, `Tram route "${routeNo}" was not found.`, { routeNo });
    }

    const stops = await getTramRouteStops(aggregate.route_no, aggregate.operator);
    return {
      ...this.toSummary(aggregate),
      stops: stops.map((row) => ({
        id: row.id,
        stopName: row.stop_name,
        // Stays null when the source had no sequence. Never coerced to 0.
        stopSequenceNo: row.stop_sequence_no,
        depot: row.depot,
        normalizedName: normalizeStopName(row.stop_name),
      })),
    };
  }

  /** Stops for a route number plus its canonical identity, as for bus routes. */
  async getRouteStops(
    routeNo: string,
    operator?: string,
  ): Promise<{ routeNo: string; operator: string; mode: "TRAM"; stops: TramRouteStopView[] }> {
    const detail = await this.getRoute(routeNo, operator);
    return { routeNo: detail.routeNo, operator: detail.operator, mode: "TRAM", stops: detail.stops };
  }

  private toSummary(row: TramRouteAggregate): TramRouteSummary {
    return {
      routeId: buildRouteNodeId("TRAM", row.operator, row.route_no),
      routeNo: row.route_no,
      mode: "TRAM",
      operator: row.operator,
      vehicleType: "tram",
      depot: row.depot,
      stopCount: row.stop_count,
      // Every stop has a sequence only when sequenced_count equals stop_count.
      fullySequenced: row.sequenced_count === row.stop_count,
      firstStop: row.first_stop,
      lastStop: row.last_stop,
      hasTimetable: false,
    };
  }
}

let instance: TramService | null = null;
export function getTramService(): TramService {
  if (!instance) instance = new TramService();
  return instance;
}

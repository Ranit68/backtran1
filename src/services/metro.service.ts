import {
  METRO_OPERATOR,
  METRO_TABLES,
  countMetroLines,
  countMetroTimedLineStations,
  countMetroTrips,
  getMetroCoverageSummary,
  getMetroCheckpointStationNames,
  getMetroDistinctStations,
  getMetroHopStats,
  getMetroInterchangeStations,
  getMetroLine,
  getMetroLineStations,
  getMetroLineTripStats,
  getMetroLinesServingStation,
  getMetroRouteByIdOrCode,
  getMetroStationByName,
  getMetroStationTimetableRows,
  getMetroTableCounts,
  getMetroTripCheckpointCounts,
  listMetroLines,
  listMetroTrips,
  parseServiceDays,
  searchMetroStations,
  type MetroLineAggregate,
  type MetroLineListFilter,
  type MetroStationAggregate,
  type MetroTripListFilter,
} from "../repositories/metro.repository.js";
import type {
  MetroLineDetail,
  MetroLineStationView,
  MetroLineSummary,
  MetroSearchResult,
  MetroStationTimetableView,
  MetroStationView,
  MetroTripRow,
  MetroTripView,
} from "../models/metro.model.js";
import type { PagedData } from "../types/transport.js";
import { AppError, ErrorCode } from "../utils/errors.js";
import { buildStopNodeId, normalizeStopName } from "../utils/normalize.js";
import { requireDatabase } from "../repositories/base.repository.js";
import { isPlaceholderStop } from "../graph/graph.node.js";

/**
 * Metro use cases.
 *
 * A Metro "route" is a line: `metro_routes` holds six of them, `metro_stations`
 * holds each line's ordered stations, and `metro_trips` plus
 * `metro_timetable_checkpoints` hold the real schedule.
 *
 * Two honesty rules run through every response here:
 *
 *  1. A line can be listed and routed while having no timetable at all. The
 *     Pink Line has ten stations and zero supplied trips. `hasTimetable` is
 *     false for it and the source coverage note is passed through verbatim, so a
 *     client cannot mistake "we have the station list" for "we can plan a timed
 *     trip".
 *  2. `stationsWithTimetable` is always reported next to `stopCount`, because
 *     only 15 of the 80 stations have a scheduled time of their own (16
 *     line/station pairs, since Noapara is timed on two lines). The rest are
 *     real stations on the line whose arrival time is interpolated from the
 *     line's real measured hop time, exactly as bus mid-route segments are.
 */
export class MetroService {
  async listRoutes(filter: MetroLineListFilter): Promise<PagedData<MetroLineSummary>> {
    requireDatabase();
    const [rows, total] = await Promise.all([listMetroLines(filter), countMetroLines({ q: filter.q })]);

    const items = rows.map((row) => this.toLineSummary(row));
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

  async getRoute(routeId: string): Promise<MetroLineDetail> {
    requireDatabase();

    const aggregate = await getMetroRouteByIdOrCode(routeId);
    if (!aggregate) {
      const available = (await listMetroLines({ limit: 100, offset: 0 })).map((row) => row.line);
      throw new AppError(ErrorCode.ROUTE_NOT_FOUND, `Metro line "${routeId}" was not found.`, {
        routeId,
        availableLines: available,
      });
    }

    const rows = await getMetroLineStations(aggregate.line);
    const stops: MetroLineStationView[] = rows.map((row) => ({
      stationId: row.station_code ?? `${row.line}-${row.station_sequence}`,
      name: row.station_name,
      stationSequence: row.station_sequence,
      stationCode: row.station_code,
      hasTimetable: row.timetable_exact_checkpoint,
      coverage: row.coverage,
      note: row.note,
      normalizedName: normalizeStopName(row.station_name),
    }));

    // Metro lines are supplied in one direction, so there is exactly one
    // ordering. Reported so a client can see the order is the supplied order
    // rather than a verified timetable order.
    const orderings = new Set(rows.map((row) => row.station_sequence)).size;

    return { ...this.toLineSummary(aggregate), stops, orderings };
  }

  /**
   * Stations across every line, or along one line when `line` is given.
   *
   * `total` counts distinct station names, so Esplanade -- served by four lines
   * -- is one station with `lines` listing all four, not four stations.
   */
  async getStations(filter: {
    line?: string;
    q?: string;
    limit: number;
    offset: number;
  }): Promise<PagedData<MetroStationView>> {
    requireDatabase();

    const [all, interchanges, lines] = await Promise.all([
      getMetroDistinctStations(),
      getMetroInterchangeStations(),
      listMetroLines({ limit: 100, offset: 0 }),
    ]);
    const lineNameByCode = new Map(lines.map((row) => [row.line, row.line_name]));
    const interchangeNames = new Set(interchanges.map((row) => row.station_name.toLowerCase()));
    const allByName = new Map(all.map((row) => [row.station_name.toLowerCase(), row]));

    let items: MetroStationView[];

    if (filter.line) {
      const line = await getMetroLine(filter.line);
      if (!line) {
        throw new AppError(ErrorCode.ROUTE_NOT_FOUND, `Metro line "${filter.line}" was not found.`, {
          line: filter.line,
        });
      }
      const rows = await getMetroLineStations(line.line);
      items = rows.map((row) => {
        const aggregate = allByName.get(row.station_name.toLowerCase());
        return this.toStationView({
          name: row.station_name,
          line: row.line,
          lineName: lineNameByCode.get(row.line) ?? row.line,
          stationSequence: row.station_sequence,
          stationCode: row.station_code,
          hasTimetable: row.timetable_exact_checkpoint,
          coverage: row.coverage,
          note: row.note,
          lines: aggregate?.lines ?? [row.line],
          isInterchange: interchangeNames.has(row.station_name.toLowerCase()),
        });
      });
    } else {
      const term = filter.q;
      const rows = term
        ? (await searchMetroStations(term, 500)).filter((row) => matchesTerm(term, row.station_name))
        : all;
      items = rows
        .filter((row) => !isPlaceholderStop(row.station_name))
        .map((row) =>
          this.toStationView({
            name: row.station_name,
            line: row.lines[0] ?? "",
            lineName: lineNameByCode.get(row.lines[0] ?? "") ?? "",
            stationSequence: 0,
            stationCode: row.station_codes.find((code) => code !== null) ?? null,
            hasTimetable: row.has_timetable,
            coverage: null,
            note: null,
            lines: row.lines,
            isInterchange: interchangeNames.has(row.station_name.toLowerCase()),
          }),
        );
    }

    const page = items.slice(filter.offset, filter.offset + filter.limit);
    return {
      items: page,
      page: {
        total: items.length,
        limit: filter.limit,
        offset: filter.offset,
        returned: page.length,
        hasMore: filter.offset + page.length < items.length,
      },
    };
  }

  async getStation(
    stationId: string,
  ): Promise<
    Omit<MetroStationView, "lines"> & {
      isInterchange: boolean;
      lines: { line: string; lineName: string; stationSequence: number; hasTimetable: boolean }[];
    }
  > {
    requireDatabase();

    const rows = await getMetroLinesServingStation(stationId);
    if (rows.length === 0) {
      throw new AppError(ErrorCode.STATION_NOT_FOUND, `Metro station "${stationId}" was not found.`, {
        stationId,
      });
    }

    const [lines, aggregate, interchanges] = await Promise.all([
      listMetroLines({ limit: 100, offset: 0 }),
      getMetroStationByName(rows[0]!.station_name),
      getMetroInterchangeStations(),
    ]);
    const lineNameByCode = new Map(lines.map((row) => [row.line, row.line_name]));
    const first = rows[0]!;
    const isInterchange = interchanges.some(
      (row) => row.station_name.toLowerCase() === first.station_name.toLowerCase(),
    );

    return {
      ...this.toStationView({
        name: first.station_name,
        line: first.line,
        lineName: lineNameByCode.get(first.line) ?? first.line,
        stationSequence: first.station_sequence,
        stationCode: first.station_code,
        hasTimetable: aggregate?.has_timetable ?? false,
        coverage: first.coverage,
        note: first.note,
        lines: aggregate?.lines ?? rows.map((row) => row.line),
        isInterchange,
      }),
      isInterchange,
      lines: rows.map((row) => ({
        line: row.line,
        lineName: lineNameByCode.get(row.line) ?? row.line,
        stationSequence: row.station_sequence,
        hasTimetable: row.timetable_exact_checkpoint,
      })),
    };
  }

  /** Scheduled departures at a station, from the real timetable checkpoints. */
  async getStationTimetable(
    stationId: string,
    filter: { serviceDay?: string; direction?: string; from?: string; limit: number; offset: number },
  ): Promise<MetroStationTimetableView & { total: number; serviceDays: string[] }> {
    requireDatabase();

    const serving = await getMetroLinesServingStation(stationId);
    if (serving.length === 0) {
      throw new AppError(ErrorCode.STATION_NOT_FOUND, `Metro station "${stationId}" was not found.`, {
        stationId,
      });
    }

    const rows = await getMetroStationTimetableRows(serving[0]!.station_name);
    const hasCheckpoint = serving.some((row) => row.timetable_exact_checkpoint);

    const filtered = rows.filter((row) => {
      if (filter.serviceDay && row.service_day !== filter.serviceDay) return false;
      if (filter.direction && row.direction !== filter.direction) return false;
      if (filter.from && row.scheduled_time.slice(0, 5) < filter.from) return false;
      return true;
    });

    const page = filtered.slice(filter.offset, filter.offset + filter.limit);

    return {
      stationId: serving[0]!.station_code ?? serving[0]!.station_name,
      name: serving[0]!.station_name,
      lines: serving.map((row) => row.line),
      serviceDays: [...new Set(rows.map((row) => row.service_day))].sort(),
      total: filtered.length,
      departures: page.map((row) => ({
        line: row.line,
        serviceDay: row.service_day,
        direction: row.direction,
        time: row.scheduled_time.slice(0, 5),
        destination: row.destination_station_name,
        tripId: row.trip_id,
        trainNo: row.train_no,
      })),
      // Stated rather than implied: a station can be on the line and still have
      // no printed time, which is true of 64 of the 80 line-station entries.
      note: hasCheckpoint
        ? null
        : "The supplied timetable PDFs print no time for this station. It is still a real station on the line, so journeys through it use interpolated times and are labelled as estimates.",
    };
  }

  async listTrips(filter: MetroTripListFilter): Promise<PagedData<MetroTripView> & { line: string }> {
    requireDatabase();

    const line = await getMetroLine(filter.line);
    if (!line) {
      throw new AppError(ErrorCode.ROUTE_NOT_FOUND, `Metro line "${filter.line}" was not found.`, {
        line: filter.line,
      });
    }

    const [rows, total] = await Promise.all([listMetroTrips(filter), countMetroTrips(filter)]);
    const checkpointCounts = await getMetroTripCheckpointCounts(
      rows.map((row) => ({
        line: row.line,
        tripId: row.trip_id,
        serviceDay: row.service_day,
        direction: row.direction,
      })),
    );

    const items = rows.map((row) =>
      this.toTripView(
        row,
        checkpointCounts.get(`${row.trip_id}|${row.service_day}|${row.direction}`) ?? 0,
      ),
    );

    return {
      line: line.line,
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

  async searchStations(term: string, limit: number): Promise<MetroSearchResult[]> {
    requireDatabase();

    const rows = await searchMetroStations(term, Math.max(limit * 4, 50));
    const candidates = rows.length > 0 ? rows : await getMetroDistinctStations();

    return candidates
      .filter((row) => !isPlaceholderStop(row.station_name) && matchesTerm(term, row.station_name))
      .slice(0, limit)
      .map((row) => ({
        name: row.station_name,
        mode: "METRO" as const,
        lines: row.lines,
        routeCount: row.line_count,
        hasTimetable: row.has_timetable,
        normalizedName: normalizeStopName(row.station_name),
        nodeId: buildStopNodeId("METRO", METRO_OPERATOR, row.station_name),
      }));
  }

  /** Where the Metro data actually stops and starts, for the Network tab. */
  async diagnostics(): Promise<{
    tables: readonly { name: string; purpose: string }[];
    counts: { lines: number; stations: number; trips: number; checkpoints: number };
    lines: Awaited<ReturnType<typeof getMetroCoverageSummary>>;
    hopStats: Awaited<ReturnType<typeof getMetroHopStats>>;
    tripStats: Awaited<ReturnType<typeof getMetroLineTripStats>>;
    interchanges: Awaited<ReturnType<typeof getMetroInterchangeStations>>;
    /** Distinct station names with at least one printed time. */
    stationsWithTimetable: string[];
    /** (line, station) entries with a printed time, comparable to the entry total. */
    timedLineStations: number;
    notes: string[];
  }> {
    requireDatabase();
    const [counts, lines, hopStats, tripStats, interchanges, timedStations, timedLineStations] =
      await Promise.all([
        getMetroTableCounts(),
        getMetroCoverageSummary(),
        getMetroHopStats(),
        getMetroLineTripStats(),
        getMetroInterchangeStations(),
        getMetroCheckpointStationNames(),
        countMetroTimedLineStations(),
      ]);

    const notes: string[] = [];
    const withoutTrips = lines.filter((line) => line.trips === 0);
    if (withoutTrips.length > 0) {
      notes.push(
        `${withoutTrips.map((line) => line.line).join(", ")} ${
          withoutTrips.length === 1 ? "has" : "have"
        } stations but no supplied timetable, so ${
          withoutTrips.length === 1 ? "its" : "their"
        } travel times are static estimates.`,
      );
    }
    const mapOnly = lines.filter((line) => line.map_only_stations > 0);
    if (mapOnly.length > 0) {
      notes.push(
        `Stations taken from the supplied map only, with no timetable entry: ${mapOnly
          .map((line) => `${line.line} (${line.map_only_stations})`)
          .join(", ")}.`,
      );
    }
    const totalStations = lines.reduce((sum, line) => sum + line.stations, 0);
    notes.push(
      `Only ${timedLineStations} of ${totalStations} line/station entries have a printed scheduled time ` +
        `(${timedStations.length} distinct station names in total). ` +
        `The other ${totalStations - timedLineStations} are real stations on their line whose time is ` +
        `interpolated from the line's measured average hop time, and are labelled as estimates.`,
    );
    notes.push(
      "Interchanges are matched by normalised station name because the Metro source data carries no coordinates. " +
        `Only ${interchanges.length} station names are served by more than one line: ${interchanges
          .map((row) => `${row.station_name} (${row.lines.join(", ")})`)
          .join("; ")}.`,
    );
    const isolated = lines.filter(
      (line) => interchanges.every((row) => !row.lines.includes(line.line)),
    );
    if (isolated.length > 0) {
      notes.push(
        `${isolated.map((line) => line.line).join(", ")}: no station on ${
          isolated.length === 1 ? "this line" : "these lines"
        } shares a name with any other line, so it cannot be combined with another line in a journey.`,
      );
    }
    notes.push(
      "`trip_id` is not unique in the source data -- 1,720 trip rows share 1,364 distinct values, because a service " +
        "pattern is listed once per day type. Runs are therefore keyed on (line, trip_id, service_day, direction).",
    );
    notes.push(
      "Per-hop times are measured between consecutive printed times inside a run rather than by dividing an average " +
        "trip duration by the station count, which would understate them on lines that also run short-turn services.",
    );
    notes.push(
      "The Metro source data carries no coordinates, so totalDistanceKm stays omitted and Metro<->Bus interchanges " +
        "are matched by normalised station name.",
    );

    return {
      tables: METRO_TABLES,
      counts,
      lines,
      hopStats,
      tripStats,
      interchanges,
      stationsWithTimetable: timedStations,
      timedLineStations,
      notes,
    };
  }

  private toLineSummary(row: MetroLineAggregate): MetroLineSummary {
    return {
      routeId: row.line,
      routeNo: row.line,
      mode: "METRO",
      operator: METRO_OPERATOR,
      name: row.line_name,
      stopCount: row.stop_count,
      firstStop: row.first_stop,
      lastStop: row.last_stop,
      serviceDays: parseServiceDays(row.service_days_in_uploaded_timetables),
      stationsWithTimetable: row.checkpoint_station_count,
      hasTimetable: row.trip_count > 0,
      coverageNote: row.coverage_note,
    };
  }

  private toStationView(input: {
    name: string;
    line: string;
    lineName: string;
    stationSequence: number;
    stationCode: string | null;
    hasTimetable: boolean;
    coverage: string | null;
    note: string | null;
    lines: string[];
    isInterchange: boolean;
  }): MetroStationView {
    return {
      stationId: input.stationCode ?? input.name,
      name: input.name,
      line: input.line,
      lineName: input.lineName,
      stationSequence: input.stationSequence,
      stationCode: input.stationCode,
      hasTimetable: input.hasTimetable,
      coverage: input.coverage,
      note: input.note,
      normalizedName: normalizeStopName(input.name),
      // More than one line means a genuine interchange, which is the signal a
      // client needs to offer a change here.
      lines: input.lines,
    };
  }

  private toTripView(row: MetroTripRow, checkpointCount: number): MetroTripView {
    return {
      tripId: row.trip_id,
      trainNo: row.train_no,
      line: row.line,
      serviceDay: row.service_day,
      direction: row.direction,
      origin: row.origin_station_name,
      destination: row.destination_station_name,
      departureTime: row.departure_time.slice(0, 5),
      arrivalTime: row.arrival_time.slice(0, 5),
      durationMinutes: row.duration_minutes === null ? null : Number(row.duration_minutes),
      checkpointStations: checkpointCount,
      timingScope: row.timing_scope,
      validFrom:
        row.valid_from instanceof Date
          ? row.valid_from.toISOString().slice(0, 10)
          : row.valid_from
            ? String(row.valid_from).slice(0, 10)
            : null,
    };
  }
}

/**
 * Terminal relevance check.
 *
 * The SQL pre-filter is a plain ILIKE, so "espl" would not match "Esplanade".
 * This mirrors the prefix and word-prefix rules `scoreSearchMatch` applies to
 * bus and Metro, so Metro responds to partial input the same way.
 */
function matchesTerm(term: string, candidate: string): boolean {
  const q = normalizeStopName(term);
  const c = normalizeStopName(candidate);
  if (q.length === 0 || c.length === 0) return false;
  if (c.startsWith(q) || c.includes(q)) return true;
  return q.split(" ").every((token) => c.split(" ").some((word) => word.startsWith(token)));
}

let instance: MetroService | null = null;
export function getMetroService(): MetroService {
  if (!instance) instance = new MetroService();
  return instance;
}

export type { MetroStationAggregate };

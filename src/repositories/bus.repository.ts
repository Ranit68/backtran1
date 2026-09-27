import { query, queryOne } from "../config/database.js";
import { env } from "../config/env.js";
import type { BusRouteStopRow, BusTimetableRow, RouteTripStatsRow } from "../models/bus.model.js";
import {
  escapeLike,
  requireDatabase,
  withDatabaseErrors,
  type PageOptions,
} from "./base.repository.js";

/**
 * Data access for bus route stops and bus timetables.
 *
 * Reads are read-only by design: the specification's development order puts
 * data import in the scripts layer, not behind the API, and section 28 warns
 * against rewriting source values.
 */

export interface BusRouteListFilter extends PageOptions {
  operator?: string;
  /** Case-insensitive substring on route_no. */
  q?: string;
  sort?: "route_no" | "stop_count" | "avg_trip_minutes";
  order?: "asc" | "desc";
}

export interface BusRouteAggregate {
  operator: string;
  route_no: string;
  stop_count: number;
  first_stop: string | null;
  last_stop: string | null;
  depot: string | null;
  timetable_count: number;
  avg_trip_minutes: number | null;
}

export interface BusDistinctStop {
  stop_name: string;
  operator: string;
  route_count: number;
}

// ---------------------------------------------------------------------------
// Route listing
// ---------------------------------------------------------------------------

const AGGREGATE_CTE = `
  WITH timetable AS (
    SELECT route_no, COUNT(*)::int AS timetable_count
    FROM bus_timetables
    GROUP BY route_no
  ),
  stats AS (
    SELECT
      route_no,
      SUM(avg_trip_minutes * sample_count) / NULLIF(SUM(sample_count), 0) AS avg_trip_minutes
    FROM route_trip_stats
    WHERE mode = 'BUS'
    GROUP BY route_no
  )
`;

export async function listBusRoutes(filter: BusRouteListFilter): Promise<BusRouteAggregate[]> {
  requireDatabase();
  const { limit, offset, operator, q } = filter;
  const sortColumn =
    filter.sort === "stop_count"
      ? "stop_count"
      : filter.sort === "avg_trip_minutes"
        ? "avg_trip_minutes"
        : "b.route_no";
  const direction = filter.order === "desc" ? "DESC" : "ASC";
  const pattern = q ? `%${escapeLike(q)}%` : null;

  return withDatabaseErrors(() =>
    query<BusRouteAggregate>(
      `${AGGREGATE_CTE}
       SELECT
         b.operator,
         b.route_no,
         COUNT(*)::int AS stop_count,
         (array_agg(b.stop_name ORDER BY b.stop_sequence_no ASC))[1] AS first_stop,
         (array_agg(b.stop_name ORDER BY b.stop_sequence_no DESC))[1] AS last_stop,
         (array_agg(b.depot ORDER BY b.stop_sequence_no ASC))[1] AS depot,
         COALESCE(t.timetable_count, 0)::int AS timetable_count,
         stats.avg_trip_minutes
       FROM bus_route_stops b
       LEFT JOIN timetable t ON t.route_no = b.route_no
       LEFT JOIN stats ON stats.route_no = b.route_no
       WHERE ($1::text IS NULL OR b.operator = $1::text)
         AND ($2::text IS NULL OR b.route_no ILIKE $2::text ESCAPE '\\')
       GROUP BY b.operator, b.route_no, t.timetable_count, stats.avg_trip_minutes
       ORDER BY ${sortColumn} ${direction} NULLS LAST, b.route_no ASC
       LIMIT $3 OFFSET $4`,
      [operator ?? null, pattern, limit, offset],
    ),
  );
}

export async function countBusRoutes(filter: Pick<BusRouteListFilter, "operator" | "q">): Promise<number> {
  requireDatabase();
  const pattern = filter.q ? `%${escapeLike(filter.q)}%` : null;
  const row = await withDatabaseErrors(() =>
    queryOne<{ count: string }>(
      `SELECT COUNT(DISTINCT (operator, route_no))::text AS count
       FROM bus_route_stops
       WHERE ($1::text IS NULL OR operator = $1::text)
         AND ($2::text IS NULL OR route_no ILIKE $2::text ESCAPE '\\')`,
      [filter.operator ?? null, pattern],
    ),
  );
  return Number(row?.count ?? 0);
}

export async function getBusRoute(
  routeNo: string,
  operator?: string,
): Promise<BusRouteAggregate | null> {
  requireDatabase();
  return withDatabaseErrors(() =>
    queryOne<BusRouteAggregate>(
      `${AGGREGATE_CTE}
       SELECT
         b.operator,
         b.route_no,
         COUNT(*)::int AS stop_count,
         (array_agg(b.stop_name ORDER BY b.stop_sequence_no ASC))[1] AS first_stop,
         (array_agg(b.stop_name ORDER BY b.stop_sequence_no DESC))[1] AS last_stop,
         (array_agg(b.depot ORDER BY b.stop_sequence_no ASC))[1] AS depot,
         COALESCE(t.timetable_count, 0)::int AS timetable_count,
         stats.avg_trip_minutes
       FROM bus_route_stops b
       LEFT JOIN timetable t ON t.route_no = b.route_no
       LEFT JOIN stats ON stats.route_no = b.route_no
       WHERE b.route_no = $1
         AND ($2::text IS NULL OR b.operator = $2::text)
       GROUP BY b.operator, b.route_no, t.timetable_count, stats.avg_trip_minutes`,
      [routeNo, operator ?? null],
    ),
  );
}

export async function getBusRouteStops(
  routeNo: string,
  operator?: string,
): Promise<BusRouteStopRow[]> {
  requireDatabase();
  return withDatabaseErrors(() =>
    query<BusRouteStopRow>(
      `SELECT id, operator, vehicle_type, route_no, depot, stop_sequence_no, stop_name, created_at
       FROM bus_route_stops
       WHERE route_no = $1
         AND ($2::text IS NULL OR operator = $2::text)
       ORDER BY stop_sequence_no ASC`,
      [routeNo, operator ?? null],
    ),
  );
}

/** Every bus stop row, ordered for graph construction. */
export async function getAllBusStops(): Promise<BusRouteStopRow[]> {
  requireDatabase();
  return withDatabaseErrors(() =>
    query<BusRouteStopRow>(
      `SELECT id, operator, vehicle_type, route_no, depot, stop_sequence_no, stop_name, created_at
       FROM bus_route_stops
       ORDER BY operator ASC, route_no ASC, stop_sequence_no ASC`,
    ),
  );
}

/** Distinct stop names with the number of routes serving each. */
export async function getBusDistinctStops(): Promise<BusDistinctStop[]> {
  requireDatabase();
  return withDatabaseErrors(() =>
    query<BusDistinctStop>(
      `SELECT stop_name, MIN(operator) AS operator, COUNT(DISTINCT route_no)::int AS route_count
       FROM bus_route_stops
       GROUP BY stop_name
       ORDER BY stop_name ASC`,
    ),
  );
}

export async function searchBusStops(term: string, limit: number): Promise<BusDistinctStop[]> {
  requireDatabase();
  const pattern = `%${escapeLike(term)}%`;
  return withDatabaseErrors(() =>
    query<BusDistinctStop>(
      `SELECT stop_name, MIN(operator) AS operator, COUNT(DISTINCT route_no)::int AS route_count
       FROM bus_route_stops
       WHERE stop_name ILIKE $1 ESCAPE '\\'
       GROUP BY stop_name
       ORDER BY stop_name ASC
       LIMIT $2`,
      [pattern, limit],
    ),
  );
}

/** Route numbers served by a given stop name (exact, as stored). */
export async function getRoutesServingStop(stopName: string): Promise<
  { route_no: string; operator: string }[]
> {
  requireDatabase();
  return withDatabaseErrors(() =>
    query<{ route_no: string; operator: string }>(
      `SELECT DISTINCT route_no, operator
       FROM bus_route_stops
       WHERE stop_name = $1
       ORDER BY route_no ASC`,
      [stopName],
    ),
  );
}

// ---------------------------------------------------------------------------
// Route number resolution (route-stop namespace -> timetable namespace)
// ---------------------------------------------------------------------------

/**
 * The route-stop file and the timetable file use different route_no formats
 * (for example "C-11" vs "11A"), and the specification forbids guessing that
 * they are the same service. This resolves a route-stop route number into the
 * set of timetable route numbers that are KNOWN to refer to it, using three
 * rules in priority order:
 *
 *   1. an explicit row in route_aliases (shipped empty, for a human to fill),
 *   2. an exact string match,
 *   3. a match after stripping non-alphanumerics, so "AC-3" finds "AC 3".
 *
 * When all three miss, the result is the route number itself, and the caller
 * falls back to static estimated travel times.
 */
export async function resolveTimetableRouteNos(mode: "BUS", routeNo: string): Promise<string[]> {
  requireDatabase();
  const rows = await withDatabaseErrors(() =>
    query<{ route_no: string }>(
      `SELECT $2::text AS route_no
       UNION
       SELECT ra.target_route_no
         FROM route_aliases ra
        WHERE ra.mode = $1 AND ra.source_route_no = $2
       UNION
       SELECT t.route_no
         FROM bus_timetables t
        WHERE regexp_replace(lower(t.route_no), '[^a-z0-9]+', '', 'g')
            = regexp_replace(lower($2::text), '[^a-z0-9]+', '', 'g')`,
      [mode, routeNo],
    ),
  );
  return rows.map((row) => row.route_no);
}

// ---------------------------------------------------------------------------
// Timetable
// ---------------------------------------------------------------------------

export interface BusTimetableFilter extends PageOptions {
  routeNo: string;
  operator?: string;
  directionId?: number;
  /** Only trips departing at or after this many minutes since midnight. */
  fromMinutes?: number;
}

export async function getBusTimetable(filter: BusTimetableFilter): Promise<BusTimetableRow[]> {
  requireDatabase();
  return withDatabaseErrors(() =>
    query<BusTimetableRow>(
      `SELECT id, operator, route_no, trip_no, direction_id, origin, destination,
              departure_time, arrival_time, source_image_order, created_at
       FROM bus_timetables
       WHERE route_no = $1
         AND ($2::text IS NULL OR operator = $2::text)
         AND ($3::int IS NULL OR direction_id = $3::int)
         AND ($4::int IS NULL
              OR (EXTRACT(EPOCH FROM departure_time) / 60)::int >= $4::int)
       ORDER BY departure_time ASC NULLS LAST, trip_no ASC
       LIMIT $5 OFFSET $6`,
      [filter.routeNo, filter.operator ?? null, filter.directionId ?? null, filter.fromMinutes ?? null, filter.limit, filter.offset],
    ),
  );
}

export async function countBusTimetable(filter: Omit<BusTimetableFilter, "limit" | "offset">): Promise<number> {
  requireDatabase();
  const row = await withDatabaseErrors(() =>
    queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM bus_timetables
       WHERE route_no = $1
         AND ($2::text IS NULL OR operator = $2::text)
         AND ($3::int IS NULL OR direction_id = $3::int)
         AND ($4::int IS NULL
              OR (EXTRACT(EPOCH FROM departure_time) / 60)::int >= $4::int)`,
      [filter.routeNo, filter.operator ?? null, filter.directionId ?? null, filter.fromMinutes ?? null],
    ),
  );
  return Number(row?.count ?? 0);
}

export async function listBusTimetableRoutes(): Promise<{ route_no: string; operator: string | null; trip_count: number }[]> {  requireDatabase();
  return withDatabaseErrors(() =>
    query<{ route_no: string; operator: string | null; trip_count: number }>(
      `SELECT route_no, MIN(operator) AS operator, COUNT(*)::int AS trip_count
       FROM bus_timetables
       GROUP BY route_no
       ORDER BY route_no ASC`,
    ),
  );
}

/** All timetable rows for the given route numbers, used by the journey planner. */
export async function getTimetableForRouteNos(routeNos: string[]): Promise<BusTimetableRow[]> {
  requireDatabase();
  if (routeNos.length === 0) return [];
  return withDatabaseErrors(() =>
    query<BusTimetableRow>(
      `SELECT id, operator, route_no, trip_no, direction_id, origin, destination,
              departure_time, arrival_time, source_image_order, created_at
       FROM bus_timetables
       WHERE route_no = ANY($1::text[])
       ORDER BY route_no ASC, departure_time ASC NULLS LAST, trip_no ASC`,
      [routeNos],
    ),
  );
}

export interface MultiRouteTimetableFilter extends PageOptions {
  directionId?: number;
  fromMinutes?: number;
}

/**
 * Timetable lookup across several route numbers at once.
 *
 * Needed because a route-stop route number and a timetable route number are not
 * the same namespace (for example "C-11" vs "11A"), and the timetable endpoint
 * has to accept either spelling.
 */
export async function getBusTimetableByRouteNos(
  routeNos: string[],
  filter: MultiRouteTimetableFilter,
): Promise<BusTimetableRow[]> {
  requireDatabase();
  if (routeNos.length === 0) return [];
  return withDatabaseErrors(() =>
    query<BusTimetableRow>(
      `SELECT id, operator, route_no, trip_no, direction_id, origin, destination,
              departure_time, arrival_time, source_image_order, created_at
       FROM bus_timetables
       WHERE route_no = ANY($1::text[])
         AND ($2::int IS NULL OR direction_id = $2::int)
         AND ($3::int IS NULL
              OR (EXTRACT(EPOCH FROM departure_time) / 60)::int >= $3::int)
       ORDER BY departure_time ASC NULLS LAST, trip_no ASC
       LIMIT $4 OFFSET $5`,
      [routeNos, filter.directionId ?? null, filter.fromMinutes ?? null, filter.limit, filter.offset],
    ),
  );
}

export async function countBusTimetableByRouteNos(
  routeNos: string[],
  filter: Omit<MultiRouteTimetableFilter, "limit" | "offset">,
): Promise<number> {
  requireDatabase();
  if (routeNos.length === 0) return 0;
  const row = await withDatabaseErrors(() =>
    queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM bus_timetables
       WHERE route_no = ANY($1::text[])
         AND ($2::int IS NULL OR direction_id = $2::int)
         AND ($3::int IS NULL
              OR (EXTRACT(EPOCH FROM departure_time) / 60)::int >= $3::int)`,
      [routeNos, filter.directionId ?? null, filter.fromMinutes ?? null],
    ),
  );
  return Number(row?.count ?? 0);
}

// ---------------------------------------------------------------------------
// Route statistics
// ---------------------------------------------------------------------------

/**
 * Precomputed per-route trip statistics.
 *
 * Only Bus uses this table. Metro measures per-hop times from its checkpoint
 * table instead, because its trip durations come from short-turn services whose
 * average says nothing about the time between two adjacent stations.
 */
export async function getAllRouteTripStats(mode: "BUS"): Promise<RouteTripStatsRow[]> {
  requireDatabase();
  return withDatabaseErrors(() =>
    query<RouteTripStatsRow>(
      `SELECT operator, route_no, mode, sample_count, avg_trip_minutes, min_trip_minutes,
              max_trip_minutes, updated_at
       FROM route_trip_stats
       WHERE mode = $1`,
      [mode],
    ),
  );
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export interface BusDiagnostics {
  databaseConfigured: boolean;
  defaultOperator: string;
  routeStopRows: number;
  distinctRouteNos: number;
  timetableRows: number;
  timetableRouteNos: number;
  distinctStops: number;
  /** route-stop route numbers that no timetable row can be matched to. */
  routesWithoutTimetable: string[];
  /** timetable route numbers that have no route-stop data. */
  timetableRoutesWithoutStops: string[];
  /** explicit human-provided links, currently empty by default. */
  configuredAliases: { sourceRouteNo: string; targetRouteNo: string; note: string | null }[];
  /** (route_no, trip_no, direction_id) triples that appear more than once. */
  duplicateTripKeys: number;
  importRuns: {
    sourceFile: string;
    rowsRead: number;
    rowsInserted: number;
    rowsRejected: number;
    startedAt: string;
    /**
     * Free-text notes recorded by the importer, including the warning it emits
     * when a source route number loses every one of its rows to validation and
     * therefore cannot be served at all.
     */
    notes: string[];
    /** Which rows were rejected and why, up to the importer's 500-row cap. */
    rejections: { row: number; reason: string; value?: unknown }[];
  }[];
}

export async function getBusDiagnostics(): Promise<BusDiagnostics> {
  requireDatabase();
  return withDatabaseErrors(async () => {
    const [stops, timetable, aliasRows, duplicate, runs] = await Promise.all([
      queryOne<{ rows: string; routes: string; stop_names: string }>(
        `SELECT COUNT(*)::text AS rows,
                COUNT(DISTINCT (operator, route_no))::text AS routes,
                COUNT(DISTINCT stop_name)::text AS stop_names
         FROM bus_route_stops`,
      ),
      queryOne<{ rows: string; routes: string }>(
        `SELECT COUNT(*)::text AS rows, COUNT(DISTINCT route_no)::text AS routes FROM bus_timetables`,
      ),
      query<{ source_route_no: string; target_route_no: string; note: string | null }>(
        `SELECT source_route_no, target_route_no, note FROM route_aliases WHERE mode = 'BUS' ORDER BY source_route_no`,
      ),
      queryOne<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM (
           SELECT route_no, trip_no, direction_id
           FROM bus_timetables
           GROUP BY route_no, trip_no, direction_id
           HAVING COUNT(*) > 1
         ) duplicated`,
      ),
      query<{
        source_file: string;
        rows_read: number;
        rows_inserted: number;
        rows_rejected: number;
        started_at: Date;
        notes: string[] | null;
        rejections: { row: number; reason: string; value?: unknown }[] | null;
      }>(
        `SELECT source_file, rows_read, rows_inserted, rows_rejected, started_at,
                notes, rejections
         FROM import_runs
         WHERE mode = 'BUS'
         ORDER BY started_at DESC
         LIMIT 10`,
      ),
    ]);

    // Which route-stop numbers can reach a timetable row at all, using exactly
    // the three documented resolution rules.
    const linkage = await query<{ route_no: string; matched: boolean }>(
      `WITH distinct_routes AS (
         SELECT DISTINCT route_no FROM bus_route_stops
       ),
       matched AS (
         SELECT DISTINCT d.route_no
         FROM distinct_routes d
         WHERE EXISTS (SELECT 1 FROM route_aliases ra
                        WHERE ra.mode = 'BUS' AND ra.source_route_no = d.route_no)
            OR EXISTS (SELECT 1 FROM bus_timetables t WHERE t.route_no = d.route_no)
            OR EXISTS (SELECT 1 FROM bus_timetables t
                        WHERE regexp_replace(lower(t.route_no), '[^a-z0-9]+', '', 'g')
                            = regexp_replace(lower(d.route_no), '[^a-z0-9]+', '', 'g'))
       )
       SELECT d.route_no, (m.route_no IS NOT NULL) AS matched
       FROM distinct_routes d
       LEFT JOIN matched m ON m.route_no = d.route_no
       ORDER BY d.route_no`,
    );

    const routeNosInTimetable = new Set(
      (await listBusTimetableRoutes()).map((row) => row.route_no.toLowerCase().replace(/[^a-z0-9]+/g, "")),
    );
    const stopRouteNos = (await query<{ route_no: string }>(`SELECT DISTINCT route_no FROM bus_route_stops`)).map(
      (row) => row.route_no.toLowerCase().replace(/[^a-z0-9]+/g, ""),
    );
    const normalizedStops = new Set(stopRouteNos);

    return {
      databaseConfigured: env.hasDatabase,
      defaultOperator: env.DEFAULT_ROUTE_STOP_OPERATOR,
      routeStopRows: Number(stops?.rows ?? 0),
      distinctRouteNos: Number(stops?.routes ?? 0),
      distinctStops: Number(stops?.stop_names ?? 0),
      timetableRows: Number(timetable?.rows ?? 0),
      timetableRouteNos: Number(timetable?.routes ?? 0),
      routesWithoutTimetable: linkage.filter((row) => !row.matched).map((row) => row.route_no),
      timetableRoutesWithoutStops: [...routeNosInTimetable].filter((key) => !normalizedStops.has(key)).map((key) => {
        // Return the original casing rather than the normalised key.
        return key;
      }),
      configuredAliases: aliasRows.map((row) => ({
        sourceRouteNo: row.source_route_no,
        targetRouteNo: row.target_route_no,
        note: row.note,
      })),
      duplicateTripKeys: Number(duplicate?.count ?? 0),
      importRuns: runs.map((row) => ({
        sourceFile: row.source_file,
        rowsRead: row.rows_read,
        rowsInserted: row.rows_inserted,
        rowsRejected: row.rows_rejected,
        startedAt: row.started_at.toISOString(),
        notes: row.notes ?? [],
        rejections: row.rejections ?? [],
      })),
    };
  });
}

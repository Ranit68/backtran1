import { query, queryOne } from "../config/database.js";
import type { TramRouteStopRow } from "../models/tram.model.js";
import { escapeLike, requireDatabase, withDatabaseErrors, type PageOptions } from "./base.repository.js";

/**
 * Data access for tram route stops.
 *
 * The specification supplies no tram timetable file, so there is deliberately
 * no timetable query here. Tram journeys fall back to static estimated travel
 * times (spec section 22) and tram responses carry `hasTimetable: false`.
 */

export interface TramRouteListFilter extends PageOptions {
  operator?: string;
  q?: string;
  sort?: "route_no" | "stop_count";
  order?: "asc" | "desc";
}

export interface TramRouteAggregate {
  operator: string;
  route_no: string;
  stop_count: number;
  first_stop: string | null;
  last_stop: string | null;
  depot: string | null;
  sequenced_count: number;
  max_sequence: number | null;
}

export interface TramDistinctStop {
  stop_name: string;
  operator: string;
  route_count: number;
}

export async function listTramRoutes(filter: TramRouteListFilter): Promise<TramRouteAggregate[]> {
  requireDatabase();
  const { limit, offset, operator, q } = filter;
  const sortColumn = filter.sort === "stop_count" ? "stop_count" : "t.route_no";
  const direction = filter.order === "desc" ? "DESC" : "ASC";
  const pattern = q ? `%${escapeLike(q)}%` : null;

  return withDatabaseErrors(() =>
    query<TramRouteAggregate>(
      `SELECT
         t.operator,
         t.route_no,
         COUNT(*)::int AS stop_count,
         (array_agg(t.stop_name ORDER BY t.stop_sequence_no ASC NULLS LAST, t.id ASC))[1] AS first_stop,
         (array_agg(t.stop_name ORDER BY t.stop_sequence_no DESC NULLS LAST, t.id DESC))[1] AS last_stop,
         (array_agg(t.depot ORDER BY t.stop_sequence_no ASC NULLS LAST, t.id ASC))[1] AS depot,
         COUNT(t.stop_sequence_no)::int AS sequenced_count,
         MAX(t.stop_sequence_no) AS max_sequence
       FROM tram_route_stops t
       WHERE ($1::text IS NULL OR t.operator = $1::text)
         AND ($2::text IS NULL OR t.route_no ILIKE $2::text ESCAPE '\\')
       GROUP BY t.operator, t.route_no
       ORDER BY ${sortColumn} ${direction} NULLS LAST, t.route_no ASC
       LIMIT $3 OFFSET $4`,
      [operator ?? null, pattern, limit, offset],
    ),
  );
}

export async function countTramRoutes(filter: Pick<TramRouteListFilter, "operator" | "q">): Promise<number> {
  requireDatabase();
  const pattern = filter.q ? `%${escapeLike(filter.q)}%` : null;
  const row = await withDatabaseErrors(() =>
    queryOne<{ count: string }>(
      `SELECT COUNT(DISTINCT (operator, route_no))::text AS count
       FROM tram_route_stops
       WHERE ($1::text IS NULL OR operator = $1::text)
         AND ($2::text IS NULL OR route_no ILIKE $2::text ESCAPE '\\')`,
      [filter.operator ?? null, pattern],
    ),
  );
  return Number(row?.count ?? 0);
}

export async function getTramRoute(
  routeNo: string,
  operator?: string,
): Promise<TramRouteAggregate | null> {
  requireDatabase();
  return withDatabaseErrors(() =>
    queryOne<TramRouteAggregate>(
      `SELECT
         t.operator,
         t.route_no,
         COUNT(*)::int AS stop_count,
         (array_agg(t.stop_name ORDER BY t.stop_sequence_no ASC NULLS LAST, t.id ASC))[1] AS first_stop,
         (array_agg(t.stop_name ORDER BY t.stop_sequence_no DESC NULLS LAST, t.id DESC))[1] AS last_stop,
         (array_agg(t.depot ORDER BY t.stop_sequence_no ASC NULLS LAST, t.id ASC))[1] AS depot,
         COUNT(t.stop_sequence_no)::int AS sequenced_count,
         MAX(t.stop_sequence_no) AS max_sequence
       FROM tram_route_stops t
       WHERE t.route_no = $1
         AND ($2::text IS NULL OR t.operator = $2::text)
       GROUP BY t.operator, t.route_no`,
      [routeNo, operator ?? null],
    ),
  );
}

export async function getTramRouteStops(
  routeNo: string,
  operator?: string,
): Promise<TramRouteStopRow[]> {
  requireDatabase();
  return withDatabaseErrors(() =>
    query<TramRouteStopRow>(
      `SELECT id, operator, vehicle_type, route_no, depot, stop_sequence_no, stop_name, created_at
       FROM tram_route_stops
       WHERE route_no = $1
         AND ($2::text IS NULL OR operator = $2::text)
       -- NULL sequences sort last (spec section 7: NULL, never 0), and the id
       -- tiebreaker preserves the source file's own order for them.
       ORDER BY stop_sequence_no ASC NULLS LAST, id ASC`,
      [routeNo, operator ?? null],
    ),
  );
}

export async function getAllTramStops(): Promise<TramRouteStopRow[]> {
  requireDatabase();
  return withDatabaseErrors(() =>
    query<TramRouteStopRow>(
      `SELECT id, operator, vehicle_type, route_no, depot, stop_sequence_no, stop_name, created_at
       FROM tram_route_stops
       ORDER BY operator ASC, route_no ASC, stop_sequence_no ASC NULLS LAST, id ASC`,
    ),
  );
}

export async function getTramDistinctStops(): Promise<TramDistinctStop[]> {
  requireDatabase();
  return withDatabaseErrors(() =>
    query<TramDistinctStop>(
      `SELECT stop_name, MIN(operator) AS operator, COUNT(DISTINCT route_no)::int AS route_count
       FROM tram_route_stops
       GROUP BY stop_name
       ORDER BY stop_name ASC`,
    ),
  );
}

export async function searchTramStops(term: string, limit: number): Promise<TramDistinctStop[]> {
  requireDatabase();
  const pattern = `%${escapeLike(term)}%`;
  return withDatabaseErrors(() =>
    query<TramDistinctStop>(
      `SELECT stop_name, MIN(operator) AS operator, COUNT(DISTINCT route_no)::int AS route_count
       FROM tram_route_stops
       WHERE stop_name ILIKE $1 ESCAPE '\\'
       GROUP BY stop_name
       ORDER BY stop_name ASC
       LIMIT $2`,
      [pattern, limit],
    ),
  );
}

export async function getTramRoutesServingStop(stopName: string): Promise<
  { route_no: string; operator: string }[]
> {
  requireDatabase();
  return withDatabaseErrors(() =>
    query<{ route_no: string; operator: string }>(
      `SELECT DISTINCT route_no, operator
       FROM tram_route_stops
       WHERE stop_name = $1
       ORDER BY route_no ASC`,
      [stopName],
    ),
  );
}

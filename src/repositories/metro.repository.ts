import { query, queryOne } from "../config/database.js";
import { env } from "../config/env.js";
import type {
  MetroCheckpointRow,
  MetroDirection,
  MetroHopStatsRow,
  MetroLineTripStatsRow,
  MetroRouteRow,
  MetroServiceDay,
  MetroStationRow,
  MetroTripRow,
} from "../models/metro.model.js";
import { escapeLike, requireDatabase, withDatabaseErrors, type PageOptions } from "./base.repository.js";

/**
 * Data access for Metro.
 *
 * Reads four tables that already exist in the database and are treated as
 * read-only source data:
 *
 *   metro_routes                  one row per line, with the service days the
 *                                 supplied timetables cover
 *   metro_stations                the complete ordered station list per line
 *   metro_trips                   1,720 real trips: day, direction, endpoints,
 *                                 departure, arrival, duration
 *   metro_timetable_checkpoints   the per-station times printed in the supplied
 *                                 timetable PDFs
 *
 * Nothing in this file creates, alters or drops a table, and nothing writes.
 *
 * The source coverage is uneven and is reported as such rather than smoothed
 * over. Two facts shape every query below:
 *
 *  1. `metro_stations.station_sequence` is the line's real 1-based station
 *     order, contiguous with no gaps, and `metro_trips` is consistent with it
 *     (a Blue Line trip from station 3 to station 1 takes 10 minutes, i.e. two
 *     hops). It is the only ordering the source provides, so it is used as-is.
 *  2. `metro_timetable_checkpoints.station_sequence` is NOT that line index --
 *     it is an ordinal within the owning trip, so a station's value differs
 *     between a short-turn and a full-length trip. It is only ever used to
 *     order checkpoints *within a single trip*, never to order a line.
 */

/** No operator column exists in the Metro source data, so one is fixed here. */
export const METRO_OPERATOR = "Metro Railway";

/** Service days the source distinguishes, in calendar order. */
const SERVICE_DAYS: readonly MetroServiceDay[] = ["WEEKDAY", "SATURDAY", "SUNDAY"];

export function isMetroServiceDay(value: string): value is MetroServiceDay {
  return (SERVICE_DAYS as readonly string[]).includes(value);
}

export function isMetroDirection(value: string): value is MetroDirection {
  return value === "UP" || value === "DOWN";
}

/** Splits the comma-separated service-day column into a validated array. */
export function parseServiceDays(value: string | null): MetroServiceDay[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim().toUpperCase())
    .filter((part): part is MetroServiceDay => isMetroServiceDay(part));
}

/** Turns the "BLUE" line code into a graph route node id. */
export function metroLineRouteId(line: string): string {
  return `metro:${METRO_OPERATOR.toLowerCase().replace(/[^a-z0-9]+/g, "-")}:route:${line.toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

/** A line row plus the station statistics the graph and API need. */
export interface MetroLineAggregate extends MetroRouteRow {
  stop_count: number;
  coded_station_count: number;
  checkpoint_station_count: number;
  first_stop: string | null;
  last_stop: string | null;
  trip_count: number;
  service_day_count: number;
}

const LINE_AGGREGATE_SELECT = `
  SELECT
    r.id,
    r.line,
    r.line_name,
    r.service_days_in_uploaded_timetables,
    r.coverage_note,
    r.created_at,
    COUNT(s.id)::int AS stop_count,
    COUNT(s.station_code)::int AS coded_station_count,
    COUNT(s.id) FILTER (WHERE s.timetable_exact_checkpoint)::int AS checkpoint_station_count,
    (array_agg(s.station_name ORDER BY s.station_sequence ASC NULLS LAST, s.id ASC))[1] AS first_stop,
    (array_agg(s.station_name ORDER BY s.station_sequence DESC NULLS LAST, s.id DESC))[1] AS last_stop,
    (SELECT COUNT(*)::int FROM metro_trips t WHERE t.line = r.line) AS trip_count,
    (SELECT COUNT(DISTINCT t.service_day)::int FROM metro_trips t WHERE t.line = r.line) AS service_day_count
  FROM metro_routes r
  LEFT JOIN metro_stations s ON s.line = r.line
`;

export interface MetroLineListFilter extends PageOptions {
  q?: string;
  sort?: "line" | "stop_count" | "trip_count";
  order?: "asc" | "desc";
}

export async function listMetroLines(filter: MetroLineListFilter): Promise<MetroLineAggregate[]> {
  requireDatabase();
  const sortColumn =
    filter.sort === "stop_count"
      ? "stop_count"
      : filter.sort === "trip_count"
        ? "trip_count"
        : "r.line";
  const direction = filter.order === "desc" ? "DESC" : "ASC";
  const pattern = filter.q ? `%${escapeLike(filter.q)}%` : null;

  return withDatabaseErrors(() =>
    query<MetroLineAggregate>(
      `${LINE_AGGREGATE_SELECT}
        WHERE ($1::text IS NULL
               OR r.line ILIKE $1 ESCAPE '\\'
               OR r.line_name ILIKE $1 ESCAPE '\\')
        GROUP BY r.id, r.line, r.line_name, r.service_days_in_uploaded_timetables, r.coverage_note, r.created_at
        ORDER BY ${sortColumn} ${direction} NULLS LAST, r.line ASC
        LIMIT $2 OFFSET $3`,
      [pattern, filter.limit, filter.offset],
    ),
  );
}

export async function countMetroLines(filter: Pick<MetroLineListFilter, "q">): Promise<number> {
  requireDatabase();
  const pattern = filter.q ? `%${escapeLike(filter.q)}%` : null;
  const row = await withDatabaseErrors(() =>
    queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM metro_routes r
        WHERE ($1::text IS NULL
               OR r.line ILIKE $1 ESCAPE '\\'
               OR r.line_name ILIKE $1 ESCAPE '\\')`,
      [pattern],
    ),
  );
  return Number(row?.count ?? 0);
}

/** Resolves a line by its code, case-insensitively. */
export async function getMetroLine(line: string): Promise<MetroLineAggregate | null> {
  requireDatabase();
  return withDatabaseErrors(() =>
    queryOne<MetroLineAggregate>(
      `${LINE_AGGREGATE_SELECT}
        WHERE lower(r.line) = lower($1)
        GROUP BY r.id, r.line, r.line_name, r.service_days_in_uploaded_timetables, r.coverage_note, r.created_at`,
      [line],
    ),
  );
}

/**
 * Resolves a line from a path parameter.
 *
 * Accepts the line code case-insensitively ("blue") and also the numeric
 * primary key, so a client holding either identifier gets the same line.
 */
export async function getMetroRouteByIdOrCode(routeId: string): Promise<MetroLineAggregate | null> {
  requireDatabase();
  return withDatabaseErrors(() =>
    queryOne<MetroLineAggregate>(
      `${LINE_AGGREGATE_SELECT}
        WHERE lower(r.line) = lower($1) OR r.id::text = $1
        GROUP BY r.id, r.line, r.line_name, r.service_days_in_uploaded_timetables, r.coverage_note, r.created_at
        LIMIT 1`,
      [routeId],
    ),
  );
}

/** The tables this repository reads, and what each one is for. */
export const METRO_TABLES = [
  { name: "metro_routes", purpose: "One row per line, with the service days the supplied timetables cover." },
  { name: "metro_stations", purpose: "The complete ordered station list for every line, with per-station coverage." },
  { name: "metro_trips", purpose: "Real scheduled trips: day, direction, endpoints, departure, arrival, duration." },
  {
    name: "metro_timetable_checkpoints",
    purpose: "The per-station times printed in the supplied timetable PDFs.",
  },
] as const;

// ---------------------------------------------------------------------------
// Stations
// ---------------------------------------------------------------------------

export async function getMetroLineStations(line: string): Promise<MetroStationRow[]> {
  requireDatabase();
  return withDatabaseErrors(() =>
    query<MetroStationRow>(
      `SELECT id, line, station_sequence, station_code, station_name,
              timetable_exact_checkpoint, coverage, note, created_at
         FROM metro_stations
        WHERE lower(line) = lower($1)
        -- station_sequence is the line order and is NOT NULL in the source, so
        -- this is a total order with no tiebreaker guesswork.
        ORDER BY station_sequence ASC`,
      [line],
    ),
  );
}

/** Every station on every line, ordered by line then position. Used by the graph. */
export async function getAllMetroStations(): Promise<MetroStationRow[]> {
  requireDatabase();
  return withDatabaseErrors(() =>
    query<MetroStationRow>(
      `SELECT id, line, station_sequence, station_code, station_name,
              timetable_exact_checkpoint, coverage, note, created_at
         FROM metro_stations
        ORDER BY line ASC, station_sequence ASC`,
    ),
  );
}

/** Stations that appear on more than one line, i.e. genuine interchanges. */
export async function getMetroInterchangeStations(): Promise<
  { station_name: string; line_count: number; lines: string[] }[]
> {
  requireDatabase();
  return withDatabaseErrors(() =>
    query<{ station_name: string; line_count: number; lines: string[] }>(
      `SELECT station_name,
              COUNT(DISTINCT line)::int AS line_count,
              array_agg(DISTINCT line ORDER BY line) AS lines
         FROM metro_stations
        GROUP BY station_name
       HAVING COUNT(DISTINCT line) > 1
        ORDER BY station_name ASC`,
    ),
  );
}

export interface MetroStationAggregate {
  station_name: string;
  line_count: number;
  lines: string[];
  station_codes: (string | null)[];
  checkpoint_count: number;
  has_timetable: boolean;
}

/** Distinct stations across all lines, with the lines that serve each one. */
export async function getMetroDistinctStations(): Promise<MetroStationAggregate[]> {
  requireDatabase();
  return withDatabaseErrors(() =>
    query<MetroStationAggregate>(
      `SELECT station_name,
              COUNT(DISTINCT line)::int AS line_count,
              array_agg(DISTINCT line ORDER BY line) AS lines,
              array_agg(DISTINCT station_code) AS station_codes,
              COUNT(*) FILTER (WHERE timetable_exact_checkpoint)::int AS checkpoint_count,
              BOOL_OR(timetable_exact_checkpoint) AS has_timetable
         FROM metro_stations
        GROUP BY station_name
        ORDER BY station_name ASC`,
    ),
  );
}

export async function getMetroStationByName(name: string): Promise<MetroStationAggregate | null> {
  requireDatabase();
  return withDatabaseErrors(() =>
    queryOne<MetroStationAggregate>(
      `SELECT station_name,
              COUNT(DISTINCT line)::int AS line_count,
              array_agg(DISTINCT line ORDER BY line) AS lines,
              array_agg(DISTINCT station_code) AS station_codes,
              COUNT(*) FILTER (WHERE timetable_exact_checkpoint)::int AS checkpoint_count,
              BOOL_OR(timetable_exact_checkpoint) AS has_timetable
         FROM metro_stations
        WHERE lower(station_name) = lower($1)
        GROUP BY station_name`,
      [name],
    ),
  );
}

export async function searchMetroStations(
  term: string,
  limit: number,
): Promise<MetroStationAggregate[]> {
  requireDatabase();
  const pattern = `%${escapeLike(term)}%`;
  return withDatabaseErrors(() =>
    query<MetroStationAggregate>(
      `SELECT station_name,
              COUNT(DISTINCT line)::int AS line_count,
              array_agg(DISTINCT line ORDER BY line) AS lines,
              array_agg(DISTINCT station_code) AS station_codes,
              COUNT(*) FILTER (WHERE timetable_exact_checkpoint)::int AS checkpoint_count,
              BOOL_OR(timetable_exact_checkpoint) AS has_timetable
         FROM metro_stations
        WHERE station_name ILIKE $1 ESCAPE '\\'
        GROUP BY station_name
        ORDER BY station_name ASC
        LIMIT $2`,
      [pattern, limit],
    ),
  );
}

/** Lines serving a station, for the station detail endpoint. */
export async function getMetroLinesServingStation(stationName: string): Promise<MetroStationRow[]> {
  requireDatabase();
  return withDatabaseErrors(() =>
    query<MetroStationRow>(
      `SELECT id, line, station_sequence, station_code, station_name,
              timetable_exact_checkpoint, coverage, note, created_at
         FROM metro_stations
        WHERE lower(station_name) = lower($1)
        ORDER BY line ASC, station_sequence ASC`,
      [stationName],
    ),
  );
}

// ---------------------------------------------------------------------------
// Trips and timings
// ---------------------------------------------------------------------------

/**
 * Real end-to-end trip duration per line and direction.
 *
 * Reported for transparency and as a cross-check on `getMetroHopStats`, but NOT
 * used for the graph: see `MetroHopStatsRow` for why the average duration
 * divided by the hop count is misleading for this data.
 */
export async function getMetroLineTripStats(): Promise<MetroLineTripStatsRow[]> {
  requireDatabase();
  return withDatabaseErrors(() =>
    query<MetroLineTripStatsRow>(
      `SELECT line,
              direction,
              COUNT(*)::int AS trip_count,
              ROUND(AVG(duration_minutes)::numeric, 3)::float8 AS avg_trip_minutes,
              ROUND(MIN(duration_minutes)::numeric, 3)::float8 AS min_trip_minutes,
              ROUND(MAX(duration_minutes)::numeric, 3)::float8 AS max_trip_minutes
         FROM metro_trips
        WHERE duration_minutes IS NOT NULL AND duration_minutes > 0
        GROUP BY line, direction
        ORDER BY line ASC, direction ASC`,
    ),
  );
}

export interface MetroTripListFilter extends PageOptions {
  line: string;
  serviceDay?: string;
  direction?: string;
  /** Only trips departing at or after this HH:MM. */
  from?: string;
}

/**
 * Real minutes per hop for each line, measured between consecutive scheduled
 * checkpoints inside the same run.
 *
 * Two details of the source data drive the shape of this query:
 *
 *  1. `metro_timetable_checkpoints.station_sequence` cannot be used to pair
 *     checkpoints. It is a per-trip ordinal that is not always contiguous (all
 *     243 Green Line runs have gaps in it) and its direction does not even match
 *     the direction of travel. Checkpoints are therefore paired by ordered
 *     `scheduled_time` within a run, which is always monotonic and therefore
 *     always the real travel order.
 *  2. A DOWN run travels from a high `station_sequence` to a low one, i.e.
 *     against the stored order, so the span is `ABS()` of the position delta.
 *
 * A run is identified by (line, trip_id, service_day, direction). `trip_id`
 * alone is NOT unique: 1,720 trip rows share only 1,364 distinct `trip_id`
 * values, because the same service pattern is listed separately for weekday,
 * Saturday and Sunday (Green Line `CCHM-02` departs 08:37, 09:00 and 09:29 on
 * the three day types). Pairing on `trip_id` alone would mix the three day types
 * together and invent journeys that do not exist.
 */
export async function getMetroHopStats(): Promise<MetroHopStatsRow[]> {
  requireDatabase();
  return withDatabaseErrors(() =>
    query<MetroHopStatsRow>(
      `WITH ordered AS (
         SELECT c.line,
                c.scheduled_time,
                s.station_sequence AS pos,
                LAG(s.station_sequence) OVER w AS prev_pos,
                LAG(c.scheduled_time)  OVER w AS prev_time
           FROM metro_timetable_checkpoints c
           JOIN metro_stations s ON s.line = c.line AND s.station_code = c.station_code
         WINDOW w AS (PARTITION BY c.line, c.trip_id, c.service_day, c.direction
                             ORDER BY c.scheduled_time, c.station_sequence)
       )
       SELECT line,
              COUNT(*)::int AS span_count,
              SUM(ABS(pos - prev_pos))::int AS hop_count,
              ROUND(AVG((((EXTRACT(EPOCH FROM (scheduled_time::time - prev_time::time)) + 86400) % 86400) / 60.0)
                         / ABS(pos - prev_pos))::numeric, 3)::float8 AS avg_minutes_per_hop,
              ROUND(MIN((((EXTRACT(EPOCH FROM (scheduled_time::time - prev_time::time)) + 86400) % 86400) / 60.0)
                         / ABS(pos - prev_pos))::numeric, 3)::float8 AS min_minutes_per_hop,
              ROUND(MAX((((EXTRACT(EPOCH FROM (scheduled_time::time - prev_time::time)) + 86400) % 86400) / 60.0)
                         / ABS(pos - prev_pos))::numeric, 3)::float8 AS max_minutes_per_hop
         FROM ordered
        WHERE prev_pos IS NOT NULL AND ABS(pos - prev_pos) > 0
        GROUP BY line
        ORDER BY line ASC`,
    ),
  );
}

/** Distinct station names that have at least one printed time. */
export async function getMetroCheckpointStationNames(): Promise<string[]> {
  requireDatabase();
  const rows = await withDatabaseErrors(() =>
    query<{ station_name: string }>(
      `SELECT DISTINCT s.station_name
         FROM metro_stations s
         JOIN metro_timetable_checkpoints c
           ON c.line = s.line AND c.station_code = s.station_code
        ORDER BY s.station_name ASC`,
    ),
  );
  return rows.map((row) => row.station_name);
}

/**
 * How many (line, station) entries on the network have a printed time.
 *
 * This is the figure comparable with the line/station entry total, unlike the
 * distinct-name count: a name served by three lines and printed once is three
 * timed entries but one name, and Park Street is timed on Blue and Purple while
 * being untimed on Green.
 */
export async function countMetroTimedLineStations(): Promise<number> {
  requireDatabase();
  const row = await withDatabaseErrors(() =>
    query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM (
           SELECT DISTINCT c.line, s.station_name
             FROM metro_stations s
             JOIN metro_timetable_checkpoints c
               ON c.line = s.line AND c.station_code = s.station_code
         ) timed`,
    ),
  );
  return Number(row[0]?.count ?? 0);
}

export async function listMetroTrips(filter: MetroTripListFilter): Promise<MetroTripRow[]> {
  requireDatabase();
  return withDatabaseErrors(() =>
    query<MetroTripRow>(
      `SELECT id, trip_id, train_no, line, service_day, direction,
              origin_station_code, origin_station_name, departure_time,
              destination_station_code, destination_station_name, arrival_time,
              duration_minutes::float8 AS duration_minutes,
              timing_scope, valid_from, source_file, created_at
         FROM metro_trips
        WHERE lower(line) = lower($1)
          AND ($2::text IS NULL OR service_day = $2::text)
          AND ($3::text IS NULL OR direction = $3::text)
          AND ($4::text IS NULL OR departure_time::text LIKE $4::text)
        ORDER BY service_day ASC, direction ASC, departure_time ASC
        LIMIT $5 OFFSET $6`,
      [
        filter.line,
        filter.serviceDay ?? null,
        filter.direction ?? null,
        filter.from ? `${filter.from}%` : null,
        filter.limit,
        filter.offset,
      ],
    ),
  );
}

export async function countMetroTrips(filter: Pick<MetroTripListFilter, "line" | "serviceDay" | "direction" | "from">): Promise<number> {
  requireDatabase();
  const row = await withDatabaseErrors(() =>
    queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM metro_trips
        WHERE lower(line) = lower($1)
          AND ($2::text IS NULL OR service_day = $2::text)
          AND ($3::text IS NULL OR direction = $3::text)
          AND ($4::text IS NULL OR departure_time::text LIKE $4::text)`,
      [filter.line, filter.serviceDay ?? null, filter.direction ?? null, filter.from ? `${filter.from}%` : null],
    ),
  );
  return Number(row?.count ?? 0);
}

/** How many real scheduled checkpoints one run has, for labelling `hasTimetable`. */
export async function getMetroTripCheckpointCounts(
  runs: { line: string; tripId: string; serviceDay: string; direction: string }[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (runs.length === 0) return counts;
  requireDatabase();

  // Keyed on (line, trip_id, service_day, direction) because trip_id alone is
  // shared by the weekday, Saturday and Sunday copies of the same pattern.
  const rows = await withDatabaseErrors(() =>
    query<{ trip_id: string; service_day: string; direction: string; checkpoint_count: number }>(
      `SELECT trip_id, service_day, direction,
              COUNT(DISTINCT station_sequence)::int AS checkpoint_count
         FROM metro_timetable_checkpoints
        WHERE lower(line) = lower($1)
          AND (trip_id, service_day, direction) IN (
            SELECT * FROM UNNEST($2::text[], $3::text[], $4::text[])
          )
        GROUP BY trip_id, service_day, direction`,
      [
        runs[0]!.line,
        [...new Set(runs.map((run) => run.tripId))],
        [...new Set(runs.map((run) => run.serviceDay))],
        [...new Set(runs.map((run) => run.direction))],
      ],
    ),
  );

  // The query filters the cross product, so re-apply the exact tuple match here
  // before handing counts back to the caller.
  const wanted = new Set(runs.map((run) => `${run.tripId}|${run.serviceDay}|${run.direction}`));
  for (const row of rows) {
    if (!wanted.has(`${row.trip_id}|${row.service_day}|${row.direction}`)) continue;
    counts.set(`${row.trip_id}|${row.service_day}|${row.direction}`, row.checkpoint_count);
  }
  return counts;
}

/**
 * Scheduled times for one station, joined to the run that serves it.
 *
 * Resolves the station's line/code pairs through `metro_stations` rather than
 * matching `metro_timetable_checkpoints.station_name`, which is nullable.
 *
 * The join to `metro_trips` includes `service_day` and `direction` on purpose.
 * `trip_id` alone is not unique -- 1,720 trip rows share 1,364 distinct
 * `trip_id` values, since a pattern is listed once per day type -- so joining on
 * it alone inflates this result from 5,849 checkpoint rows to 7,653 by pairing
 * every checkpoint with all three day-type copies of its run.
 */
export async function getMetroStationTimetableRows(stationName: string): Promise<
  (MetroCheckpointRow & { destination_station_name: string; arrival_time: string })[]
> {
  requireDatabase();
  return withDatabaseErrors(() =>
    query<MetroCheckpointRow & { destination_station_name: string; arrival_time: string }>(
      `SELECT c.id, c.trip_id, c.train_no, c.line, c.service_day, c.direction,
              c.station_code, c.station_sequence, c.station_name, c.scheduled_time,
              c.event_type, c.timing_scope, c.valid_from, c.source_file, c.created_at,
              t.destination_station_name, t.arrival_time
         FROM metro_timetable_checkpoints c
         JOIN metro_stations s
           ON s.line = c.line AND s.station_code = c.station_code
         JOIN metro_trips t
           ON t.line = c.line
          AND t.trip_id = c.trip_id
          AND t.service_day = c.service_day
          AND t.direction = c.direction
        WHERE lower(s.station_name) = lower($1)
          AND c.event_type = 'DEPARTURE'
        -- Ordered by printed time, not by station_sequence: the per-trip ordinal
        -- is not contiguous and does not follow the direction of travel.
        ORDER BY c.line ASC, c.service_day ASC, c.direction ASC, c.scheduled_time ASC`,
      [stationName],
    ),
  );
}

/**
 * Every real run that travels between two stations on a line, with the real
 * scheduled times for that journey.
 *
 * A run qualifies when both stations lie between the run's endpoints and the
 * run passes them in the order the passenger is travelling. Direction is derived
 * from the stored station order rather than from the source `direction` label,
 * because a DOWN run moves from a higher `station_sequence` to a lower one.
 *
 * `boardTime` and `alightTime` are the times actually printed for those two
 * stations in that run, and are independently nullable -- which is the honest
 * shape of this data:
 *
 *  - `boardTime` is normally present, because the timetable prints a departure
 *    at the origin and at intermediate stations.
 *  - `alightTime` is present only when the alighting station is the run's
 *    terminus. The source prints a single ARRIVAL per run, at its destination,
 *    so there is no printed arrival time to quote for a station in the middle.
 *
 * A caller that gets both can report an exact time; a caller that gets only
 * `boardTime` knows exactly when the train left and must estimate the rest.
 */
export interface MetroLegRun {
  line: string;
  tripId: string;
  trainNo: string | null;
  serviceDay: string;
  direction: string;
  runOrigin: string;
  runDestination: string;
  originPosition: number;
  destinationPosition: number;
  /** Position distance of the whole run, always positive. */
  runHops: number;
  /** Position of the passenger's boarding station on the line. */
  boardPosition: number;
  /** Position of the passenger's alighting station on the line. */
  alightPosition: number;
  /** Position distance the passenger travels, always positive. */
  legHops: number;
  /** Real departure of the run at its own origin. */
  runDepartureTime: string;
  runArrivalTime: string;
  runDurationMinutes: number | null;
  /** Printed departure at the boarding station, when the timetable has one. */
  boardTime: string | null;
  /** Printed arrival at the alighting station, only when it is the terminus. */
  alightTime: string | null;
}

export async function getMetroRunsBetweenStations(
  line: string,
  fromStation: string,
  toStation: string,
): Promise<MetroLegRun[]> {
  requireDatabase();
  return withDatabaseErrors(() =>
    query<MetroLegRun>(
      `WITH line_stations AS (
         SELECT line, station_name, station_code, station_sequence
           FROM metro_stations
          WHERE lower(line) = lower($1)
       ),
       bounds AS (
         SELECT f.station_sequence AS from_position,
                tt.station_sequence AS to_position
           FROM line_stations f
           CROSS JOIN line_stations tt
          WHERE lower(f.station_name) = lower($2)
            AND lower(tt.station_name) = lower($3)
       ),
       runs AS (
         SELECT t.line,
                t.trip_id,
                t.train_no,
                t.service_day,
                t.direction,
                so.station_sequence AS origin_position,
                sd.station_sequence AS destination_position,
                t.departure_time::text AS run_departure_time,
                t.arrival_time::text AS run_arrival_time,
                t.duration_minutes::float8 AS run_duration_minutes
           FROM metro_trips t
           JOIN line_stations so
             ON so.line = t.line AND lower(so.station_name) = lower(t.origin_station_name)
           JOIN line_stations sd
             ON sd.line = t.line AND lower(sd.station_name) = lower(t.destination_station_name)
          WHERE lower(t.line) = lower($1)
            AND so.station_sequence <> sd.station_sequence
       )
       SELECT r.line,
              r.trip_id,
              r.train_no,
              r.service_day,
              r.direction,
              (SELECT station_name FROM line_stations WHERE line = r.line AND station_sequence = r.origin_position) AS run_origin,
              (SELECT station_name FROM line_stations WHERE line = r.line AND station_sequence = r.destination_position) AS run_destination,
              r.origin_position,
              r.destination_position,
              ABS(r.destination_position - r.origin_position) AS run_hops,
              b.from_position AS board_position,
              b.to_position AS alight_position,
              ABS(b.to_position - b.from_position) AS leg_hops,
              r.run_departure_time,
              r.run_arrival_time,
              r.run_duration_minutes,
              (SELECT c.scheduled_time::text
                 FROM metro_timetable_checkpoints c
                 JOIN line_stations cs ON cs.line = c.line AND cs.station_code = c.station_code
                WHERE c.line = r.line AND c.trip_id = r.trip_id
                  AND c.service_day = r.service_day AND c.direction = r.direction
                  AND cs.station_sequence = b.from_position
                  AND c.event_type = 'DEPARTURE'
                ORDER BY c.scheduled_time ASC
                LIMIT 1) AS board_time,
              (SELECT c.scheduled_time::text
                 FROM metro_timetable_checkpoints c
                 JOIN line_stations cs ON cs.line = c.line AND cs.station_code = c.station_code
                WHERE c.line = r.line AND c.trip_id = r.trip_id
                  AND c.service_day = r.service_day AND c.direction = r.direction
                  AND cs.station_sequence = b.to_position
                  AND c.event_type = 'ARRIVAL'
                ORDER BY c.scheduled_time DESC
                LIMIT 1) AS alight_time
         FROM runs r
         CROSS JOIN bounds b
        WHERE b.from_position <> b.to_position
          AND r.origin_position BETWEEN b.from_position AND b.to_position
          AND r.destination_position BETWEEN b.from_position AND b.to_position
          -- Same direction of travel as the passenger.
          AND (b.to_position - b.from_position) * (r.destination_position - r.origin_position) > 0
        ORDER BY r.service_day ASC, r.run_departure_time ASC`,
      [line, fromStation, toStation],
    ),
  );
}

/** Average minutes per hop, used to interpolate a time at an unprinted station. */
export async function getMetroAverageMinutesPerHop(line: string): Promise<number | null> {
  requireDatabase();
  const row = await withDatabaseErrors(() =>
    queryOne<{ avg_minutes_per_hop: number }>(
      `WITH ordered AS (
         SELECT c.scheduled_time,
                s.station_sequence AS pos,
                LAG(s.station_sequence) OVER w AS prev_pos,
                LAG(c.scheduled_time)  OVER w AS prev_time
           FROM metro_timetable_checkpoints c
           JOIN metro_stations s ON s.line = c.line AND s.station_code = c.station_code
          WHERE lower(c.line) = lower($1)
         WINDOW w AS (PARTITION BY c.line, c.trip_id, c.service_day, c.direction
                             ORDER BY c.scheduled_time, c.station_sequence)
       )
       SELECT ROUND(AVG((((EXTRACT(EPOCH FROM (scheduled_time::time - prev_time::time)) + 86400) % 86400) / 60.0)
                        / ABS(pos - prev_pos))::numeric, 3)::float8 AS avg_minutes_per_hop
         FROM ordered
        WHERE prev_pos IS NOT NULL AND ABS(pos - prev_pos) > 0`,
      [line],
    ),
  );
  return row?.avg_minutes_per_hop ?? null;
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

export interface MetroCoverageSummary {
  line: string;
  line_name: string;
  stations: number;
  stations_with_code: number;
  stations_with_timetable: number;
  map_only_stations: number;
  trips: number;
  service_days: string[];
  service_days_in_uploaded_timetables: string | null;
  coverage_note: string | null;
  min_departure: string | null;
  max_arrival: string | null;
}

/**
 * Per-line coverage, so /api/metro/diagnostics can state plainly which lines
 * have real schedules and which do not, instead of implying a complete network.
 */
export async function getMetroCoverageSummary(): Promise<MetroCoverageSummary[]> {
  requireDatabase();
  return withDatabaseErrors(() =>
    query<MetroCoverageSummary>(
      `SELECT r.line,
              r.line_name,
              COUNT(s.id)::int AS stations,
              COUNT(s.station_code)::int AS stations_with_code,
              COUNT(s.id) FILTER (WHERE s.timetable_exact_checkpoint)::int AS stations_with_timetable,
              COUNT(s.id) FILTER (WHERE s.coverage = 'MAP-ONLY')::int AS map_only_stations,
              (SELECT COUNT(*)::int FROM metro_trips t WHERE t.line = r.line) AS trips,
              (SELECT array_agg(DISTINCT t.service_day ORDER BY t.service_day)
                 FROM metro_trips t WHERE t.line = r.line) AS service_days,
              r.service_days_in_uploaded_timetables,
              r.coverage_note,
              (SELECT MIN(t.departure_time)::text FROM metro_trips t WHERE t.line = r.line) AS min_departure,
              (SELECT MAX(t.arrival_time)::text FROM metro_trips t WHERE t.line = r.line) AS max_arrival
         FROM metro_routes r
         LEFT JOIN metro_stations s ON s.line = r.line
        GROUP BY r.id, r.line, r.line_name, r.service_days_in_uploaded_timetables, r.coverage_note
        ORDER BY r.line ASC`,
    ),
  );
}

export interface MetroTableCounts {
  lines: number;
  stations: number;
  trips: number;
  checkpoints: number;
}

export async function getMetroTableCounts(): Promise<MetroTableCounts> {
  requireDatabase();
  const row = await withDatabaseErrors(() =>
    queryOne<MetroTableCounts>(
      `SELECT (SELECT COUNT(*)::int FROM metro_routes) AS lines,
              (SELECT COUNT(*)::int FROM metro_stations) AS stations,
              (SELECT COUNT(*)::int FROM metro_trips) AS trips,
              (SELECT COUNT(*)::int FROM metro_timetable_checkpoints) AS checkpoints`,
    ),
  );
  // A count subquery always returns exactly one row; the fallback only guards a
  // driver that hands back null, and keeps the return type non-optional.
  return row ?? { lines: 0, stations: 0, trips: 0, checkpoints: 0 };
}

/** True when the four Metro tables exist and hold at least one line. */
export async function isMetroConfigured(): Promise<boolean> {
  if (!env.hasDatabase) return false;
  try {
    const row = await queryOne<{ present: boolean }>(
      `SELECT
         (to_regclass('public.metro_routes') IS NOT NULL
          AND to_regclass('public.metro_stations') IS NOT NULL
          AND to_regclass('public.metro_trips') IS NOT NULL
          AND to_regclass('public.metro_timetable_checkpoints') IS NOT NULL) AS present`,
    );
    if (!row?.present) return false;
    const counts = await queryOne<{ lines: number }>(
      `SELECT COUNT(*)::int AS lines FROM metro_routes`,
    );
    return (counts?.lines ?? 0) > 0;
  } catch {
    return false;
  }
}

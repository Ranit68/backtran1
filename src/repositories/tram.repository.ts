import { query, queryOne } from "../config/database.js";
import { escapeLike, loadAllRows, requireDatabase, withDatabaseErrors } from "./base.repository.js";
import type {
  TramDiagnostics,
  TramExcludedHistoricalRouteRow,
  TramHeritageServiceRow,
  TramLegRow,
  TramRouteRow,
  TramServiceRow,
  TramSourceRow,
  TramStopRow,
} from "../models/tram.model.js";

/**
 * Tram data access, against the imported `tram_*` tables.
 *
 * Three separate concerns are kept apart on purpose:
 *   - `tram_routes` / `tram_stops` / `tram_legs` / `tram_services` describe the
 *     regular passenger network and are the only tables the graph is built from.
 *   - `tram_heritage_services` is special-service information. It is readable
 *     over the API but is never routed, because a heritage tram is not a
 *     service a passenger can plan a normal journey around.
 *   - `tram_excluded_historical_routes` records routes deliberately kept out of
 *     the live graph. Listing them is useful; routing them is not.
 *
 * Direction handling: `tram_legs` already carries an explicit FORWARD and a
 * REVERSE row for every segment, so both travel directions are present as
 * recorded. No reverse edge is synthesised, which would double every segment.
 */

export const TRAM_OPERATIONAL_STATUS = "OPERATIONAL";

/**
 * The operator both live tram routes are run by, exactly as the source data
 * spells it. Graph node ids are built from this string, so it must match the
 * value in tram_routes.operator character for character.
 */
export const TRAM_OPERATOR = "WBTC / CTC";

const NON_ROUTABLE_STATUSES = new Set(["SUSPENDED", "CANCELLED", "CANCELLED_TODAY"]);

export function isTramRouteRoutable(status: string | null | undefined): boolean {
  const normalized = (status ?? "").trim().toUpperCase();
  if (NON_ROUTABLE_STATUSES.has(normalized)) return false;
  return normalized === TRAM_OPERATIONAL_STATUS;
}

/**
 * A route whose service is irregular has no published headway, so it must not
 * be planned as if a tram arrives every N minutes.
 */
export function isFixedFrequencyPattern(pattern: string | null | undefined): boolean {
  const normalized = (pattern ?? "").trim().toUpperCase();
  return normalized !== "" && normalized !== "IRREGULAR" && normalized !== "UNKNOWN";
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

export async function getAllTramRoutes(): Promise<TramRouteRow[]> {
  return loadAllRows<TramRouteRow>("tram_routes", "route_id");
}

export async function getAllTramStops(): Promise<TramStopRow[]> {
  return loadAllRows<TramStopRow>("tram_stops", "stop_id");
}

export async function getAllTramLegs(): Promise<TramLegRow[]> {
  return loadAllRows<TramLegRow>("tram_legs", "id");
}

export async function getAllTramServices(): Promise<TramServiceRow[]> {
  return loadAllRows<TramServiceRow>("tram_services", "id");
}

export async function getAllTramHeritageServices(): Promise<TramHeritageServiceRow[]> {
  return loadAllRows<TramHeritageServiceRow>("tram_heritage_services", "service_id");
}

export async function getAllTramExcludedHistoricalRoutes(): Promise<TramExcludedHistoricalRouteRow[]> {
  return loadAllRows<TramExcludedHistoricalRouteRow>(
    "tram_excluded_historical_routes",
    "route_id",
  );
}

export async function getAllTramSources(): Promise<TramSourceRow[]> {
  return loadAllRows<TramSourceRow>("tram_sources", "source_id");
}

export async function isTramConfigured(): Promise<boolean> {
  try {
    const row = await queryOne<{ n: number }>("SELECT COUNT(*)::int AS n FROM tram_routes");
    return (row?.n ?? 0) > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Read API
// ---------------------------------------------------------------------------

export async function listTramRoutes(filter: {
  status?: string;
  limit: number;
  offset: number;
}): Promise<TramRouteRow[]> {
  requireDatabase();
  const status = filter.status?.trim().toUpperCase();
  return withDatabaseErrors(() =>
    query<TramRouteRow>(
      `SELECT * FROM tram_routes
       WHERE ($1::text IS NULL OR UPPER(COALESCE(status, '')) = $1)
       ORDER BY route_id ASC
       LIMIT $2 OFFSET $3`,
      [status ?? null, filter.limit, filter.offset],
    ),
  );
}

export async function countTramRoutes(status?: string): Promise<number> {
  requireDatabase();
  const normalized = status?.trim().toUpperCase() ?? null;
  const row = await withDatabaseErrors(() =>
    queryOne<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM tram_routes
       WHERE ($1::text IS NULL OR UPPER(COALESCE(status, '')) = $1)`,
      [normalized],
    ),
  );
  return row?.n ?? 0;
}

/**
 * Resolves whatever the caller supplied to a `tram_routes.route_id`.
 *
 * The source numbers these routes "5" and "25" while identifying them as "TRAM5"
 * and "TRAM25", and a client will reasonably ask for either form. Matching both
 * means `/api/tram/routes/5` and `/api/tram/routes/TRAM5` are the same route.
 * There is no collision risk with another mode: this only ever reads the tram
 * tables, and the tram ids are prefixed.
 */
async function resolveTramRouteId(supplied: string): Promise<string> {
  const trimmed = supplied.trim().toUpperCase();
  const byId = await queryOne<{ route_id: string }>(
    `SELECT route_id FROM tram_routes WHERE route_id = $1`,
    [trimmed],
  );
  if (byId) return byId.route_id;
  const byNumber = await queryOne<{ route_id: string }>(
    `SELECT route_id FROM tram_routes WHERE UPPER(TRIM(route_no)) = $1 ORDER BY route_id ASC LIMIT 1`,
    [trimmed],
  );
  return byNumber?.route_id ?? trimmed;
}

export async function getTramRoute(routeId: string): Promise<TramRouteRow | null> {
  requireDatabase();
  const resolved = await resolveTramRouteId(routeId);
  return withDatabaseErrors(() =>
    queryOne<TramRouteRow>(`SELECT * FROM tram_routes WHERE route_id = $1`, [resolved]),
  );
}

/** Stops of one route in the supplied sequence order, never alphabetical. */
export async function getTramRouteStops(routeId: string): Promise<TramStopRow[]> {
  requireDatabase();
  const resolved = await resolveTramRouteId(routeId);
  return withDatabaseErrors(() =>
    query<TramStopRow>(
      `SELECT * FROM tram_stops WHERE route_id = $1
       ORDER BY stop_sequence ASC NULLS LAST, stop_id ASC`,
      [resolved],
    ),
  );
}

export async function getTramRouteLegs(routeId: string): Promise<TramLegRow[]> {
  requireDatabase();
  const resolved = await resolveTramRouteId(routeId);
  return withDatabaseErrors(() =>
    query<TramLegRow>(
      `SELECT * FROM tram_legs WHERE route_id = $1
       ORDER BY segment_sequence ASC NULLS LAST, direction ASC`,
      [resolved],
    ),
  );
}

export async function getTramRouteServices(routeId: string): Promise<TramServiceRow[]> {
  requireDatabase();
  const resolved = await resolveTramRouteId(routeId);
  return withDatabaseErrors(() =>
    query<TramServiceRow>(`SELECT * FROM tram_services WHERE route_id = $1 ORDER BY id ASC`, [
      resolved,
    ]),
  );
}

/**
 * Heritage / special tram services. Informational only: these are never loaded
 * into the journey graph, and this function is the only thing that reads them.
 */
export async function listTramHeritageServices(): Promise<TramHeritageServiceRow[]> {
  requireDatabase();
  return withDatabaseErrors(() =>
    query<TramHeritageServiceRow>(
      `SELECT * FROM tram_heritage_services ORDER BY service_id ASC`,
    ),
  );
}

/** Routes deliberately excluded from the live graph, with the reason. */
export async function listTramExcludedHistoricalRoutes(): Promise<TramExcludedHistoricalRouteRow[]> {
  requireDatabase();
  return withDatabaseErrors(() =>
    query<TramExcludedHistoricalRouteRow>(
      `SELECT * FROM tram_excluded_historical_routes ORDER BY route_id ASC`,
    ),
  );
}

export async function getTramSources(): Promise<TramSourceRow[]> {
  requireDatabase();
  return withDatabaseErrors(() =>
    query<TramSourceRow>(`SELECT * FROM tram_sources ORDER BY source_id ASC`),
  );
}

/** Distinct stop names across all routable routes, with how many serve each. */
export async function getTramDistinctStops(): Promise<{
  stop_name: string;
  route_count: number;
}[]> {
  requireDatabase();
  return withDatabaseErrors(() =>
    query<{ stop_name: string; route_count: number }>(
      `SELECT s.stop_name, COUNT(DISTINCT s.route_id)::int AS route_count
       FROM tram_stops s
       JOIN tram_routes r ON r.route_id = s.route_id
       WHERE UPPER(COALESCE(r.status, '')) = $1
       GROUP BY s.stop_name
       ORDER BY s.stop_name ASC`,
      [TRAM_OPERATIONAL_STATUS],
    ),
  );
}

export async function searchTramStops(term: string, limit: number): Promise<TramStopRow[]> {
  requireDatabase();
  const trimmed = term.trim();
  const pattern = `%${escapeLike(trimmed)}%`;
  return withDatabaseErrors(() =>
    query<TramStopRow>(
      `SELECT s.* FROM tram_stops s
       JOIN tram_routes r ON r.route_id = s.route_id
       WHERE UPPER(COALESCE(r.status, '')) = $1
         AND (s.stop_name ILIKE $2 ESCAPE '\\' OR $3 = '')
       ORDER BY
         CASE WHEN LOWER(s.stop_name) = LOWER($4) THEN 0
              WHEN LOWER(s.stop_name) LIKE LOWER($5) THEN 1
              ELSE 2 END,
         s.stop_name ASC
       LIMIT $6`,
      [TRAM_OPERATIONAL_STATUS, pattern, trimmed === "" ? "1" : "", trimmed, `${trimmed}%`, limit],
    ),
  );
}

// ---------------------------------------------------------------------------
// Diagnostics and validation
// ---------------------------------------------------------------------------

export async function getTramDiagnostics(): Promise<TramDiagnostics> {
  requireDatabase();

  const [routes, stops, legs, services, heritage, excluded] = await Promise.all([
    getAllTramRoutes().catch(() => [] as TramRouteRow[]),
    getAllTramStops().catch(() => [] as TramStopRow[]),
    getAllTramLegs().catch(() => [] as TramLegRow[]),
    getAllTramServices().catch(() => [] as TramServiceRow[]),
    getAllTramHeritageServices().catch(() => [] as TramHeritageServiceRow[]),
    getAllTramExcludedHistoricalRoutes().catch(() => [] as TramExcludedHistoricalRouteRow[]),
  ]);

  const routeIds = new Set(routes.map((r) => r.route_id));
  const missingRouteReferences = [
    ...new Set(stops.filter((s) => !routeIds.has(s.route_id)).map((s) => `${s.route_id} (stops)`)),
    ...new Set(legs.filter((l) => !routeIds.has(l.route_id)).map((l) => `${l.route_id} (legs)`)),
    ...new Set(
      services.filter((s) => !routeIds.has(s.route_id)).map((s) => `${s.route_id} (services)`),
    ),
  ];

  const duplicateStopIds = duplicates(stops.map((s) => s.stop_id));

  const serviceByRoute = new Map(services.map((s) => [s.route_id, s]));
  const routesWithIrregularService = routes
    .filter((route) => {
      const service = serviceByRoute.get(route.route_id);
      const pattern = service?.service_pattern ?? route.service_pattern;
      return !isFixedFrequencyPattern(pattern);
    })
    .map((r) => r.route_id);

  const operationalRoutes = routes.filter((r) => isTramRouteRoutable(r.status)).length;
  const suspendedRoutes = routes.filter(
    (r) => NON_ROUTABLE_STATUSES.has((r.status ?? "").trim().toUpperCase()),
  ).length;

  /**
   * A route's stop order has to be an unambiguous 1..N run. A gap, a repeat or a
   * missing number means the sequence no longer says which stop comes next, so it
   * is reported instead of being silently sorted into a possibly wrong order.
   */
  const sequencesByRoute = new Map<string, number[]>();
  for (const stop of stops) {
    if (stop.stop_sequence === null || stop.stop_sequence === undefined) continue;
    const bucket = sequencesByRoute.get(stop.route_id);
    if (bucket) bucket.push(stop.stop_sequence);
    else sequencesByRoute.set(stop.route_id, [stop.stop_sequence]);
  }
  const invalidStopSequences: string[] = [];
  for (const [routeId, sequence] of sequencesByRoute) {
    const unique = new Set(sequence);
    const sorted = [...unique].sort((a, b) => a - b);
    const isGapless =
      sorted.length > 0 && sorted[0] === 1 && sorted.every((value, index) => value === index + 1);
    if (!isGapless || unique.size !== sequence.length) {
      invalidStopSequences.push(
        `${routeId} (values=${sorted.join(",")}${unique.size !== sequence.length ? ", duplicated" : ""})`,
      );
    }
  }

  // The specification's "no negative duration" check has no field to run against
  // for tram: `tram_legs` carries no duration column at all, because both services
  // are irregular and publish no run time. A negative leg time is therefore not
  // representable, rather than merely absent. Headways are checked below.

  const servicesWithNegativeFrequency = services
    .filter((s) => s.frequency_minutes !== null && s.frequency_minutes < 0)
    .map((s) => `${s.route_id} = ${s.frequency_minutes}min`);

  const problems =
    missingRouteReferences.length +
    duplicateStopIds.length +
    invalidStopSequences.length +
    servicesWithNegativeFrequency.length;

  return {
    mode: "TRAM",
    routes: routes.length,
    stops: stops.length,
    edges: legs.length,
    operationalRoutes,
    suspendedRoutes,
    timetableRecords: services.length,
    heritageServices: heritage.length,
    excludedHistoricalRoutes: excluded.length,
    missingRouteReferences,
    duplicateStopIds,
    invalidStopSequences,
    servicesWithNegativeFrequency,
    routesWithIrregularService,
    status: routes.length === 0 ? "not_loaded" : problems > 0 ? "degraded" : "healthy",
  };
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) dupes.add(value);
    seen.add(value);
  }
  return [...dupes];
}

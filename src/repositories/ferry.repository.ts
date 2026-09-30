import { query, queryOne } from "../config/database.js";
import { escapeLike, loadAllRows, requireDatabase, withDatabaseErrors } from "./base.repository.js";
import type {
  FerryDiagnostics,
  FerryFareRow,
  FerryGhatRow,
  FerryLegRow,
  FerryRouteRow,
  FerryScheduleRow,
  FerrySourceRow,
} from "../models/ferry.model.js";

/**
 * Ferry data access, against the imported `ferry_*` tables.
 *
 * The table set is derived from the actual CSV headers, not invented: routes,
 * ghats, legs (the routing graph), schedules, fares and a sources audit trail.
 *
 * Two rules from the source data are load-bearing throughout:
 *   - A missing fare stays null. It is never turned into 0, which would be a
 *     fabricated price rather than an unknown one.
 *   - `status` decides whether a route may enter the journey graph. A suspended
 *     route stays in the database and stays visible in diagnostics; it is
 *     excluded from routing rather than deleted.
 *
 * The ferry tables carry no foreign keys between each other, so relationships
 * are established here by `route_id` and by ghat name, as the specification
 * requires.
 */

export const FERRY_OPERATIONAL_STATUS = "OPERATIONAL";

/** Statuses that must never be used for normal journey routing. */
const NON_ROUTABLE_STATUSES = new Set(["SUSPENDED", "CANCELLED", "CANCELLED_TODAY"]);

/**
 * Every status the source is allowed to use. A route carrying anything else is
 * reported by diagnostics rather than being quietly treated as live or quietly
 * dropped, because guessing either way would change what the graph serves.
 */
const KNOWN_FERRY_STATUSES = new Set([FERRY_OPERATIONAL_STATUS, ...NON_ROUTABLE_STATUSES]);

/** Case-insensitive "is this route allowed into the live graph". */
export function isFerryRouteRoutable(status: string | null | undefined): boolean {
  const normalized = (status ?? "").trim().toUpperCase();
  if (NON_ROUTABLE_STATUSES.has(normalized)) return false;
  // An unknown status is not treated as operational. Routes with a blank
  // status are reported in diagnostics rather than quietly routed.
  return normalized === FERRY_OPERATIONAL_STATUS;
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

export async function getAllFerryRoutes(): Promise<FerryRouteRow[]> {
  return loadAllRows<FerryRouteRow>("ferry_routes", "route_id");
}

export async function getAllFerryGhats(): Promise<FerryGhatRow[]> {
  return loadAllRows<FerryGhatRow>("ferry_ghats", "ghat_id");
}

export async function getAllFerryLegs(): Promise<FerryLegRow[]> {
  return loadAllRows<FerryLegRow>("ferry_legs", "route_id");
}

export async function getAllFerrySchedules(): Promise<FerryScheduleRow[]> {
  return loadAllRows<FerryScheduleRow>("ferry_schedules", "route_id");
}

export async function getAllFerryFares(): Promise<FerryFareRow[]> {
  return loadAllRows<FerryFareRow>("ferry_fares", "route_id");
}

export async function getAllFerrySources(): Promise<FerrySourceRow[]> {
  return loadAllRows<FerrySourceRow>("ferry_sources", "source_id");
}

/** Non-throwing probe so /api/health can report Ferry health without failing. */
export async function isFerryConfigured(): Promise<boolean> {
  try {
    const row = await queryOne<{ n: number }>("SELECT COUNT(*)::int AS n FROM ferry_routes");
    return (row?.n ?? 0) > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Read API
// ---------------------------------------------------------------------------

export async function listFerryRoutes(filter: {
  status?: string;
  limit: number;
  offset: number;
}): Promise<FerryRouteRow[]> {
  requireDatabase();
  const status = filter.status?.trim().toUpperCase();
  return withDatabaseErrors(() =>
    query<FerryRouteRow>(
      `SELECT * FROM ferry_routes
       WHERE ($1::text IS NULL OR UPPER(COALESCE(status, '')) = $1)
       ORDER BY route_id ASC
       LIMIT $2 OFFSET $3`,
      [status ?? null, filter.limit, filter.offset],
    ),
  );
}

export async function countFerryRoutes(status?: string): Promise<number> {
  requireDatabase();
  const normalized = status?.trim().toUpperCase() ?? null;
  const row = await withDatabaseErrors(() =>
    queryOne<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM ferry_routes
       WHERE ($1::text IS NULL OR UPPER(COALESCE(status, '')) = $1)`,
      [normalized],
    ),
  );
  return row?.n ?? 0;
}

export async function getFerryRoute(routeId: string): Promise<FerryRouteRow | null> {
  requireDatabase();
  return withDatabaseErrors(() =>
    queryOne<FerryRouteRow>(
      `SELECT * FROM ferry_routes WHERE route_id = $1`,
      [routeId.trim().toUpperCase()],
    ),
  );
}

export async function getFerryGhats(): Promise<FerryGhatRow[]> {
  requireDatabase();
  return withDatabaseErrors(() =>
    query<FerryGhatRow>(`SELECT * FROM ferry_ghats ORDER BY ghat_name ASC`),
  );
}

export async function getFerryRouteLegs(routeId: string): Promise<FerryLegRow[]> {
  requireDatabase();
  return withDatabaseErrors(() =>
    query<FerryLegRow>(
      `SELECT * FROM ferry_legs WHERE route_id = $1 ORDER BY from_ghat ASC, to_ghat ASC`,
      [routeId.trim().toUpperCase()],
    ),
  );
}

export async function getFerryRouteSchedules(routeId: string): Promise<FerryScheduleRow[]> {
  requireDatabase();
  return withDatabaseErrors(() =>
    query<FerryScheduleRow>(
      `SELECT * FROM ferry_schedules WHERE route_id = $1 ORDER BY first_departure ASC NULLS LAST`,
      [routeId.trim().toUpperCase()],
    ),
  );
}

export async function getFerryRouteFare(routeId: string): Promise<FerryFareRow | null> {
  requireDatabase();
  return withDatabaseErrors(() =>
    queryOne<FerryFareRow>(`SELECT * FROM ferry_fares WHERE route_id = $1`, [
      routeId.trim().toUpperCase(),
    ]),
  );
}

export async function getFerrySources(): Promise<FerrySourceRow[]> {
  requireDatabase();
  return withDatabaseErrors(() =>
    query<FerrySourceRow>(`SELECT * FROM ferry_sources ORDER BY source_id ASC`),
  );
}

/**
 * Ghat names for search, restricted to endpoints that operational routes actually
 * call at.
 *
 * This deliberately does not read `ferry_ghats`. The master table is missing an
 * endpoint that the legs use -- F003 calls at "Babughat / Chandpal Ghat" -- and a
 * search built from the master table would make that endpoint impossible to find
 * even though the graph can route to it. Names come from the legs for the same
 * reason the graph's nodes do, so search and routing cover the same places.
 *
 * Returns bare names because the search only needs to score them; the operator
 * that makes each name a real nodeId comes from `getFerryGhatOperators`.
 */
export async function searchFerryGhatNames(term: string, limit: number): Promise<string[]> {
  requireDatabase();
  const trimmed = term.trim();
  const pattern = `%${escapeLike(trimmed)}%`;
  return withDatabaseErrors(async () => {
    const rows = await query<{ ghat_name: string }>(
      `WITH endpoints AS (
         SELECT from_ghat AS ghat_name FROM ferry_legs
         UNION
         SELECT to_ghat AS ghat_name FROM ferry_legs
       ),
       matched AS (
         SELECT DISTINCT
                e.ghat_name,
                CASE WHEN LOWER(e.ghat_name) = LOWER($4) THEN 0
                     WHEN LOWER(e.ghat_name) LIKE LOWER($5) THEN 1
                     ELSE 2 END AS rank
         FROM endpoints e
         WHERE EXISTS (
           SELECT 1
           FROM ferry_legs l
           JOIN ferry_routes r ON r.route_id = l.route_id
           WHERE (l.from_ghat = e.ghat_name OR l.to_ghat = e.ghat_name)
             AND UPPER(COALESCE(r.status, '')) = $1
         )
           AND (e.ghat_name ILIKE $2 ESCAPE '\\' OR $3 = '')
       )
       SELECT ghat_name
       FROM matched
       ORDER BY rank ASC, ghat_name ASC
       LIMIT $6`,
      [FERRY_OPERATIONAL_STATUS, pattern, trimmed, trimmed, `${escapeLike(trimmed)}%`, limit],
    );
    return rows.map((row) => row.ghat_name);
  });
}

/**
 * Ghat search for /api/search?mode=FERRY.
 *
 * Matches ghat name and ghat code, and folds the common aliases in the source
 * data into the name itself so "Howrah" finds "Howrah Ghat" without a separate
 * alias table. Partial matching is expected -- a search is a prefix probe.
 */
export async function searchFerryGhats(term: string, limit: number): Promise<FerryGhatRow[]> {
  requireDatabase();
  const pattern = `%${escapeLike(term.trim())}%`;
  return withDatabaseErrors(() =>
    query<FerryGhatRow>(
      `SELECT * FROM ferry_ghats
       WHERE ghat_name ILIKE $1 ESCAPE '\\'
          OR COALESCE(ghat_code, '') ILIKE $1 ESCAPE '\\'
          OR $2 = ''
       ORDER BY
         CASE WHEN LOWER(ghat_name) = LOWER($3) THEN 0
              WHEN LOWER(ghat_name) LIKE LOWER($4) THEN 1
              ELSE 2 END,
         ghat_name ASC
       LIMIT $5`,
      [pattern, term.trim() === "" ? "1" : "", term.trim(), `${term.trim()}%`, limit],
    ),
  );
}

// ---------------------------------------------------------------------------
// Diagnostics and validation
// ---------------------------------------------------------------------------

/**
 * Ferry health, in the shape the specification's diagnostics example expects.
 * Data-quality problems are reported as counts and id lists, never as a throw:
 * a partial ferry data set should not stop the bus and metro API.
 */
/**
 * Every ghat name together with the operators whose operational routes call
 * there.
 *
 * A graph node is keyed on (mode, operator, normalised name), so a ghat served
 * by two operators -- Howrah is, by "WBTC" and "WBTC/HNJPSS" -- exists as two
 * nodes joined by a walking transfer. Search must return a nodeId that really
 * exists, so it needs a real operator for the ghat rather than assuming one.
 *
 * Ghats with no operational route are omitted: they have no graph node and
 * therefore cannot be used as a journey endpoint.
 *
 * The endpoint list comes from `ferry_legs`, not from the `ferry_ghats` master
 * table, because the master table and the legs disagree. F003 calls at
 * "Babughat / Chandpal Ghat", a name no master row carries. The graph builds
 * its nodes from the legs, so an index built from the master table would leave
 * that endpoint unroutable and unsearchable -- reachable only by guessing its
 * nodeId. Deriving from the legs keeps this index and the graph on exactly the
 * same set of names.
 */
export async function getFerryGhatOperators(): Promise<{ ghat_name: string; operators: string[] }[]> {
  requireDatabase();
  return withDatabaseErrors(() =>
    query<{ ghat_name: string; operators: string[] }>(
      `WITH endpoints AS (
         SELECT from_ghat AS ghat_name FROM ferry_legs
         UNION
         SELECT to_ghat AS ghat_name FROM ferry_legs
       )
       SELECT e.ghat_name,
              ARRAY_AGG(DISTINCT r.operator ORDER BY r.operator) AS operators
       FROM endpoints e
       JOIN ferry_legs l
         ON l.from_ghat = e.ghat_name OR l.to_ghat = e.ghat_name
       JOIN ferry_routes r ON r.route_id = l.route_id
       WHERE UPPER(COALESCE(r.status, '')) = $1
       GROUP BY e.ghat_name
       ORDER BY e.ghat_name ASC`,
      [FERRY_OPERATIONAL_STATUS],
    ),
  );
}

export async function getFerryDiagnostics(): Promise<FerryDiagnostics> {
  requireDatabase();

  const [routes, ghats, legs, schedules, fares] = await Promise.all([
    getAllFerryRoutes().catch(() => [] as FerryRouteRow[]),
    getAllFerryGhats().catch(() => [] as FerryGhatRow[]),
    getAllFerryLegs().catch(() => [] as FerryLegRow[]),
    getAllFerrySchedules().catch(() => [] as FerryScheduleRow[]),
    getAllFerryFares().catch(() => [] as FerryFareRow[]),
  ]);

  const routeIds = new Set(routes.map((r) => r.route_id));
  const missingRouteReferences = [
    ...new Set(
      legs
        .filter((leg) => !routeIds.has(leg.route_id))
        .map((leg) => `${leg.route_id} (legs)`),
    ),
    ...new Set(
      schedules
        .filter((s) => !routeIds.has(s.route_id))
        .map((s) => `${s.route_id} (schedules)`),
    ),
    ...new Set(
      fares.filter((f) => !routeIds.has(f.route_id)).map((f) => `${f.route_id} (fares)`),
    ),
  ];

  const duplicateRouteIds = duplicates(routes.map((r) => r.route_id));
  const duplicateGhatIds = duplicates(ghats.map((g) => g.ghat_id));

  const operationalRoutes = routes.filter((r) => isFerryRouteRoutable(r.status)).length;
  const suspendedRoutes = routes.filter(
    (r) => NON_ROUTABLE_STATUSES.has((r.status ?? "").trim().toUpperCase()),
  ).length;

  // Fares that are unverified are a data limitation to surface, not an error:
  // the graph still routes, it just cannot quote a price.
  const routesWithUnverifiedFare = routes
    .filter((r) => r.fare_inr === null || r.fare_inr === undefined)
    .map((r) => r.route_id);

  const routesWithInvalidStatus = routes
    .filter((r) => !KNOWN_FERRY_STATUSES.has((r.status ?? "").trim().toUpperCase()))
    .map((r) => `${r.route_id} (status=${r.status ?? "NULL"})`);

  const legsWithNegativeDuration = legs
    .filter((l) => l.estimated_minutes !== null && l.estimated_minutes < 0)
    .map((l) => `${l.route_id}: ${l.from_ghat} -> ${l.to_ghat} = ${l.estimated_minutes}min`);

  const schedulesWithNegativeFrequency = schedules
    .filter((s) => s.frequency_minutes !== null && s.frequency_minutes < 0)
    .map((s) => `${s.route_id} = ${s.frequency_minutes}min`);

  const problems =
    missingRouteReferences.length +
    duplicateRouteIds.length +
    duplicateGhatIds.length +
    legsWithNegativeDuration.length +
    schedulesWithNegativeFrequency.length +
    routesWithInvalidStatus.length;

  return {
    mode: "FERRY",
    routes: routes.length,
    ghats: ghats.length,
    legs: legs.length,
    schedules: schedules.length,
    operationalRoutes,
    suspendedRoutes,
    missingRouteReferences,
    duplicateRouteIds,
    duplicateGhatIds,
    routesWithInvalidStatus,
    legsWithNegativeDuration,
    schedulesWithNegativeFrequency,
    routesWithUnverifiedFare,
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

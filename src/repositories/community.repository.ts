import { randomBytes } from "node:crypto";
import { query, queryOne } from "../config/database.js";
import {
  escapeLike,
  requireDatabase,
  withDatabaseErrors,
} from "./base.repository.js";
import {
  MODE_WIDE_KEY,
  REPORT_MESSAGE_MAX_LENGTH,
  REPORT_TTL_HOURS,
  modeScope,
  type CommunityFeed,
  type CommunityMode,
  type CommunityReport,
  type RouteScope,
} from "../models/community.model.js";

/**
 * Route-scoped community reports.
 *
 * Two concerns are kept apart on purpose:
 *   - `resolveRouteScope` turns whatever a rider typed into the canonical route
 *     identity the data set uses, or returns null. Grouping is done on that
 *     canonical key and never on the display label, so "Blue Line" and
 *     "North-South / Blue Line" cannot become two separate communities.
 *   - Everything else reads and writes `community_reports`. A scope may be a
 *     single route, or the whole mode via {@link modeScope}, whose sentinel key
 *     makes the feed read every live report in the mode whatever route it is
 *     filed under.
 *
 * Expiry is enforced in SQL on every read (expires_at > NOW()), so a post
 * disappears the moment it is due. The periodic sweep below only reclaims disk
 * space; correctness does not depend on it running, because a cleanup job that
 * fails silently must never be the reason an expired post stays visible.
 */

interface Row {
  [column: string]: unknown;
}

/**
 * Resolves user input to a canonical route scope, or null when nothing matches.
 *
 * Matching is case-insensitive and tries, in order: the exact identifier, the
 * route name, and any row in `route_aliases`. The alias table is currently empty
 * in this data set, but it is consulted anyway so a post made under an old route
 * number still lands in the right community once someone populates it.
 */
export async function resolveRouteScope(
  mode: CommunityMode,
  input: string,
): Promise<RouteScope | null> {
  requireDatabase();
  return withDatabaseErrors(() => resolveScopeUnguarded(mode, input));
}

async function resolveScopeUnguarded(
  mode: CommunityMode,
  input: string,
): Promise<RouteScope | null> {
  const wanted = input.trim();
  if (!wanted) return null;
  const like = escapeLike(wanted);

  if (mode === "METRO") {
    const row = await queryOne<Row>(
      `SELECT r.line AS key, r.line_name AS label
         FROM metro_routes r
        WHERE UPPER(TRIM(r.line)) = UPPER(TRIM($1))
           OR UPPER(TRIM(r.line)) || ' LINE' = UPPER(TRIM($1))
           OR LOWER(r.line_name) LIKE LOWER($2)
        UNION ALL
       SELECT a.target_route_no,
              COALESCE((SELECT r2.line_name FROM metro_routes r2
                         WHERE UPPER(TRIM(r2.line)) = UPPER(TRIM(a.target_route_no))), a.target_route_no)
         FROM route_aliases a
        WHERE UPPER(TRIM(a.mode)) = 'METRO'
          AND UPPER(TRIM(a.source_route_no)) = UPPER(TRIM($1))
        LIMIT 1`,
      [wanted, `%${like}%`],
    );
    return row ? toScope("METRO", row) : null;
  }

  if (mode === "BUS") {
    // There is no bus_routes table, so the route number is the identity. The
    // depot is the only description available, and it is shown after the number
    // so the reader can tell which AC-4 they are looking at.
    const row = await queryOne<Row>(
      `SELECT bs.route_no AS key,
              CASE WHEN MIN(bs.depot) IS NULL THEN bs.route_no
                    ELSE bs.route_no || ' · ' || MIN(bs.depot) END AS label
         FROM bus_route_stops bs
        WHERE UPPER(TRIM(bs.route_no)) = UPPER(TRIM($1))
        GROUP BY bs.route_no
       UNION ALL
       SELECT a.target_route_no, a.target_route_no
         FROM route_aliases a
        WHERE UPPER(TRIM(a.mode)) = 'BUS'
          AND UPPER(TRIM(a.source_route_no)) = UPPER(TRIM($1))
        LIMIT 1`,
      [wanted],
    );
    return row ? toScope("BUS", row) : null;
  }

  if (mode === "FERRY") {
    const row = await queryOne<Row>(
      `SELECT r.route_id AS key, COALESCE(r.route_name, r.route_id) AS label
         FROM ferry_routes r
        WHERE UPPER(TRIM(r.route_id)) = UPPER(TRIM($1))
           OR UPPER(TRIM(r.route_name)) = UPPER(TRIM($1))
           OR LOWER(r.route_name) LIKE LOWER($2)
       UNION ALL
       SELECT a.target_route_no,
              COALESCE((SELECT f2.route_name FROM ferry_routes f2
                         WHERE UPPER(TRIM(f2.route_id)) = UPPER(TRIM(a.target_route_no))), a.target_route_no)
         FROM route_aliases a
        WHERE UPPER(TRIM(a.mode)) = 'FERRY'
          AND UPPER(TRIM(a.source_route_no)) = UPPER(TRIM($1))
        LIMIT 1`,
      [wanted, `%${like}%`],
    );
    return row ? toScope("FERRY", row) : null;
  }

  // TRAM accepts the id, the bare number and the name, because /api/tram/routes
  // already resolves all three to the same route and a rider should not have to
  // know which one the community expects.
  const row = await queryOne<Row>(
    `SELECT t.route_id AS key, COALESCE(t.route_name, t.route_id) AS label
       FROM tram_routes t
      WHERE UPPER(TRIM(t.route_id)) = UPPER(TRIM($1))
         OR UPPER(TRIM(t.route_no)) = UPPER(TRIM($1))
         OR UPPER(TRIM(t.route_name)) = UPPER(TRIM($1))
         OR LOWER(t.route_name) LIKE LOWER($2)
     UNION ALL
     SELECT a.target_route_no,
            COALESCE((SELECT t2.route_name FROM tram_routes t2
                       WHERE UPPER(TRIM(t2.route_id)) = UPPER(TRIM(a.target_route_no))), a.target_route_no)
       FROM route_aliases a
      WHERE UPPER(TRIM(a.mode)) = 'TRAM'
        AND UPPER(TRIM(a.source_route_no)) = UPPER(TRIM($1))
     LIMIT 1`,
    [wanted, `%${like}%`],
  );
  return row ? toScope("TRAM", row) : null;
}

function toScope(mode: CommunityMode, row: Row): RouteScope {
  return {
    mode,
    key: String(row.key).trim(),
    label: String(row.label ?? row.key).trim(),
  };
}

/** Random, not sequential, so the table cannot be walked by incrementing an id. */
function newReportId(): string {
  return `r_${randomBytes(8).toString("hex")}`;
}

/**
 * Normalises the message.
 *
 * Control characters are stripped rather than rejected so that a paste from a
 * terminal or a phone keyboard cannot smuggle in newlines that break the feed's
 * layout, while the text the rider typed is preserved. Angle brackets are left
 * alone on purpose: this is plain text, it is never rendered as HTML, and
 * escaping here would mean the client has to unescape it, which is how double
 * escaping bugs start.
 */
export function normaliseMessage(raw: string): string {
  return raw
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toReport(row: Row): CommunityReport {
  const createdAt = new Date(String(row.created_at));
  const expiresAt = new Date(String(row.expires_at));
  return {
    reportId: String(row.report_id),
    mode: String(row.scope_mode) as CommunityMode,
    routeKey: String(row.scope_key),
    routeLabel: String(row.scope_label),
    message: String(row.message),
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    anonymous: true,
    // Floored and clamped: a client showing "expires in 0h" is right, one
    // showing a negative countdown is not.
    expiresInHours: Math.max(
      0,
      Math.floor((expiresAt.getTime() - Date.now()) / 3_600_000),
    ),
  };
}

export async function createReport(
  scope: RouteScope,
  message: string,
): Promise<CommunityReport> {
  requireDatabase();
  const reportId = newReportId();
  const row = await withDatabaseErrors(() =>
    queryOne<Row>(
      `INSERT INTO community_reports
         (report_id, scope_mode, scope_key, scope_label, message, expires_at)
       VALUES ($1, $2, $3, $4, $5, NOW() + ($6 || ' hours')::interval)
       RETURNING report_id, scope_mode, scope_key, scope_label, message,
                 created_at, expires_at`,
      [reportId, scope.mode, scope.key, scope.label, message, String(REPORT_TTL_HOURS)],
    ),
  );
  // RETURNING always yields a row on a successful insert, so an empty result
  // means the insert did not happen. Failing loudly beats returning a post that
  // was never stored, which the caller would then render as if it were real.
  if (!row) throw new Error("community_reports insert returned no row");
  return toReport(row);
}

export async function listReports(
  scope: RouteScope,
  limit: number,
  offset = 0,
): Promise<CommunityFeed> {
  requireDatabase();
  return withDatabaseErrors(() => listReportsUnguarded(scope, limit, offset));
}

async function listReportsUnguarded(
  scope: RouteScope,
  limit: number,
  offset: number,
): Promise<CommunityFeed> {
  // Space reclamation only. A read is already correct without it, so a failure
  // here must never fail the request the rider actually made. Not awaited, and
  // the rejection is swallowed: an unhandled rejection here would take the
  // process down over a background delete.
  void sweepExpired().catch(() => undefined);

  // The whole-mode feed ignores the key column so a post filed under any route
  // stays visible in its mode's feed. Kept as one string per shape rather than
  // concatenated, because concatenation is how a column name leaks into a plan
  // that the scope index cannot serve. The placeholders are numbered per shape
  // too, so mode-wide arguments do not jump over a parameter that is not there.
  const modeWide = scope.key === MODE_WIDE_KEY;
  const rows = await query<Row>(
    modeWide
      ? `SELECT report_id, scope_mode, scope_key, scope_label, message, created_at, expires_at
           FROM community_reports
          WHERE scope_mode = $1 AND expires_at > NOW()
          ORDER BY created_at DESC, report_id DESC
          LIMIT $2 OFFSET $3`
      : `SELECT report_id, scope_mode, scope_key, scope_label, message, created_at, expires_at
           FROM community_reports
          WHERE scope_mode = $1 AND scope_key = $2 AND expires_at > NOW()
          ORDER BY created_at DESC, report_id DESC
          LIMIT $3 OFFSET $4`,
    modeWide
      ? [scope.mode, limit, offset]
      : [scope.mode, scope.key, limit, offset],
  );

  const total = await queryOne<Row>(
    `SELECT COUNT(*)::int AS total
       FROM community_reports
       WHERE scope_mode = $1
         AND ${modeWide ? "" : "scope_key = $2 AND "}expires_at > NOW()`,
    modeWide
      ? [scope.mode]
      : [scope.mode, scope.key],
  );

  const reports = (rows as Row[]).map(toReport);
  const totalActive = Number(total?.total ?? 0);
  return {
    scope,
    reports,
    totalActive,
    offset,
    // Compared against how far the caller has read, not against the page
    // length. Paging past the end of the feed must report that there is
    // nothing further rather than promising a window that will come back
    // empty forever.
    hasMore: offset + reports.length < totalActive,
    ttlHours: REPORT_TTL_HOURS,
    messageMaxLength: REPORT_MESSAGE_MAX_LENGTH,
    posting: { anonymous: true, requiresAccount: false },
  };
}

/**
 * Deletes posts that are past their expiry.
 *
 * Exposed for tests and for an admin-triggered sweep. Not on the request path:
 * a rider asking to read a feed should not wait on a table-wide delete.
 */
export async function sweepExpired(): Promise<number> {
  requireDatabase();
  return withDatabaseErrors(async () => {
    const row = await queryOne<Row>(
      `WITH deleted AS (
         DELETE FROM community_reports
          WHERE expires_at <= NOW()
          RETURNING 1
       )
       SELECT COUNT(*)::int AS removed FROM deleted`,
    );
    return Number(row?.removed ?? 0);
  });
}

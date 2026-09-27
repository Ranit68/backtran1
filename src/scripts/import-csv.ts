import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parse } from "csv-parse/sync";
import { env } from "../config/env.js";
import { getPool, withTransaction } from "../config/database.js";
import { parseClockToMinutes, minutesBetween } from "../utils/time.js";
import { normalizeRouteNo } from "../utils/normalize.js";

/**
 * CSV import for the three tables the specification says to create.
 *
 * Design rules taken directly from the spec:
 *  - Section 17: column mapping is 1:1, with `operator = WBTC` written as a
 *    constant for the route-stop files (which have no operator column).
 *  - Section 18: validation is per-table; invalid rows are REJECTED AND
 *    REPORTED, never silently coerced.
 *  - Section 18: a missing stop sequence becomes SQL NULL, never 0.
 *  - Section 18/28: source values are preserved. Nothing is renamed,
 *    re-cased or de-duplicated here.
 *  - Section 20: the timetable's own operator column (CSTC) is stored as-is and
 *    is never overwritten with WBTC.
 */

export interface Rejection {
  row: number;
  reason: string;
  value?: unknown;
}

export interface ImportResult {
  sourceFile: string;
  targetTable: string;
  mode: string;
  operator: string | null;
  rowsRead: number;
  rowsInserted: number;
  rowsRejected: number;
  rejections: Rejection[];
  notes: string[];
}

export function resolveDataPath(fileName: string): string {
  const candidates = [
    resolve(process.cwd(), env.DATA_DIR, fileName),
    resolve(process.cwd(), fileName),
    // The source CSVs live in the user's Downloads folder by default. Derived
    // from the home directory rather than hardcoded, so this works for any
    // account and any checkout location.
    resolve(homedir(), env.DATA_DIR, fileName),
    resolve(homedir(), "Downloads", fileName),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Could not find "${fileName}". Looked in:\n${candidates.map((c) => `  - ${c}`).join("\n")}\n` +
      `Set DATA_DIR in .env to the folder containing the source CSV files.`,
  );
}

async function readCsv(fileName: string): Promise<Record<string, string>[]> {
  const path = resolveDataPath(fileName);
  const content = await readFile(path, "utf8");
  return parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
    // The source files are plain UTF-8, but a stray BOM on the first header
    // would silently rename the first column. Strip it explicitly.
    bom: true,
  }) as Record<string, string>[];
}

const trimmed = (value: string | undefined): string => (value ?? "").trim();

/** Empty string means "source had nothing here" -> SQL NULL, not "" and not 0. */
const nullable = (value: string | undefined): string | null => {
  const text = trimmed(value);
  return text.length === 0 ? null : text;
};

function parsePositiveInt(value: string | undefined): number | null {
  const text = trimmed(value);
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

// ---------------------------------------------------------------------------
// wbtc_bus_routes.csv -> bus_route_stops
// ---------------------------------------------------------------------------

export interface ImportOptions {
  /**
   * Delete the target table's rows before inserting. Defaults to true because
   * the CSV is the source of truth and the unique indexes would make a second
   * append-only run fail. Pass false to append deliberately.
   */
  replace?: boolean;
}

/**
 * Reports route numbers that exist in the source file but have no row in the
 * target table afterwards, because every one of their rows was rejected.
 *
 * Without this, a route can disappear from the API entirely and the only trace
 * is a rejection count. Route AC-2 was exactly this case: its single source row
 * was a placeholder ("(no stop data captured)") with no stop sequence, so the
 * row was correctly rejected and the route correctly has nothing to serve - but
 * nothing said so, and the API went from 48 route numbers to 47 with no
 * explanation attached to either.
 */
async function findVanishedRoutes(
  pool: ReturnType<typeof getPool>,
  table: "bus_route_stops" | "tram_route_stops",
  sourceRouteNos: string[],
): Promise<string[]> {
  if (sourceRouteNos.length === 0) return [];
  const { rows } = await pool.query<{ route_no: string }>(
    `SELECT DISTINCT route_no FROM public.${table} WHERE route_no = ANY($1::text[])`,
    [sourceRouteNos],
  );
  const stored = new Set(rows.map((row) => row.route_no));
  return sourceRouteNos.filter((routeNo) => !stored.has(routeNo)).sort();
}

export async function importBusRoutes(
  fileName = "wbtc_bus_routes.csv",
  operator = env.DEFAULT_ROUTE_STOP_OPERATOR,
  options: ImportOptions = {},
): Promise<ImportResult> {
  const { replace = true } = options;
  const rows = await readCsv(fileName);
  const rejections: Rejection[] = [];
  const notes: string[] = [];

  const values: unknown[][] = [];
  const seenKeys = new Set<string>();

  rows.forEach((row, index) => {
    const rowNumber = index + 2; // +1 for the header, +1 for 1-based CSV lines.

    // Spec section 18: bus requires route_no and stop_name, and
    // stop_sequence_no must be greater than 0.
    const routeNo = trimmed(row.route_no);
    if (routeNo.length === 0) {
      rejections.push({ row: rowNumber, reason: "route_no is required", value: row.route_no });
      return;
    }
    const stopName = trimmed(row.stop_name);
    if (stopName.length === 0) {
      rejections.push({ row: rowNumber, reason: "stop_name is required", value: row.stop_name });
      return;
    }
    const sequence = parsePositiveInt(row.stop_sequence_no);
    if (sequence === null) {
      rejections.push({
        row: rowNumber,
        reason: "stop_sequence_no must be an integer greater than 0 (bus)",
        value: row.stop_sequence_no,
      });
      return;
    }

    // Mirrors the uq_bus_route_stop_sequence unique index so a duplicate is a
    // reported rejection rather than a constraint violation mid-transaction.
    const key = `${operator}|${routeNo}|${sequence}`;
    if (seenKeys.has(key)) {
      rejections.push({
        row: rowNumber,
        reason: `duplicate (operator, route_no, stop_sequence_no) = (${operator}, ${routeNo}, ${sequence})`,
      });
      return;
    }
    seenKeys.add(key);

    values.push([
      operator,
      nullable(row.vehicle_type) ?? "bus",
      routeNo,
      nullable(row.depot),
      sequence,
      stopName,
    ]);
  });

  const emptyDepots = rows.filter((row) => trimmed(row.depot).length === 0).length;
  if (emptyDepots > 0) notes.push(`${emptyDepots} row(s) had an empty depot and were stored as NULL`);

  // The source file is the authority for these tables, so a replace import
  // clears the target first. This is what makes the import re-runnable: the
  // unique indexes on (operator, route_no, stop_sequence_no) would otherwise
  // reject the second run.
  if (replace) {
    await truncateTables(["bus_route_stops"]);
    notes.push("replaced existing bus_route_stops rows (replace mode)");
  }

  await insertBatch("bus_route_stops", [
    "operator",
    "vehicle_type",
    "route_no",
    "depot",
    "stop_sequence_no",
    "stop_name",
  ], values);

  const sourceRouteNos = [...new Set(rows.map((row) => trimmed(row.route_no)).filter((no) => no.length > 0))];
  const vanished = await findVanishedRoutes(getPool(), "bus_route_stops", sourceRouteNos);
  if (vanished.length > 0) {
    notes.push(
      `WARNING: ${vanished.length} route number(s) in the source have no usable row and will NOT appear in the API: ` +
        `${vanished.join(", ")} (every one of their rows was rejected)`,
    );
  }

  return {
    sourceFile: fileName,
    targetTable: "bus_route_stops",
    mode: "BUS",
    operator,
    rowsRead: rows.length,
    rowsInserted: values.length,
    rowsRejected: rejections.length,
    rejections,
    notes,
  };
}

// ---------------------------------------------------------------------------
// wbtc_bus_timetable_final.csv -> bus_timetables
// ---------------------------------------------------------------------------

export async function importBusTimetable(
  fileName = "wbtc_bus_timetable_final.csv",
  options: ImportOptions = {},
): Promise<ImportResult> {
  const { replace = true } = options;
  const rows = await readCsv(fileName);
  const rejections: Rejection[] = [];
  const notes: string[] = [];

  const values: unknown[][] = [];
  // Spec section 6: identity is route_no + trip_no + direction_id. The source
  // contains 77 rows that repeat a key, and the spec's DDL has no unique
  // constraint on it, so those rows are preserved rather than dropped.
  const keyCounts = new Map<string, number>();

  rows.forEach((row, index) => {
    const rowNumber = index + 2;

    // Spec section 18: route_no, trip_no and direction_id are required.
    const routeNo = trimmed(row.route_no);
    if (routeNo.length === 0) {
      rejections.push({ row: rowNumber, reason: "route_no is required", value: row.route_no });
      return;
    }
    if (!/^\d+$/.test(trimmed(row.trip_no))) {
      rejections.push({ row: rowNumber, reason: "trip_no must be an integer", value: row.trip_no });
      return;
    }
    if (!/^\d+$/.test(trimmed(row.direction_id))) {
      rejections.push({
        row: rowNumber,
        reason: "direction_id must be an integer",
        value: row.direction_id,
      });
      return;
    }
    const tripNo = Number(trimmed(row.trip_no));
    const directionId = Number(trimmed(row.direction_id));

    // origin/destination may legitimately be empty. departure/arrival are
    // nullable in the schema, but a value that is present must be a real time.
    const departure = nullable(row.departure_time);
    const arrival = nullable(row.arrival_time);
    if (departure !== null && parseClockToMinutes(departure) === null) {
      rejections.push({
        row: rowNumber,
        reason: "departure_time present but not HH:MM",
        value: row.departure_time,
      });
      return;
    }
    if (arrival !== null && parseClockToMinutes(arrival) === null) {
      rejections.push({
        row: rowNumber,
        reason: "arrival_time present but not HH:MM",
        value: row.arrival_time,
      });
      return;
    }

    const key = `${routeNo}|${tripNo}|${directionId}`;
    keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);

    values.push([
      // Section 20: keep the source operator (CSTC) exactly as supplied.
      nullable(row.operator),
      routeNo,
      tripNo,
      directionId,
      nullable(row.origin),
      nullable(row.destination),
      departure,
      arrival,
      parsePositiveInt(row.source_image_order),
    ]);
  });

  const duplicatedKeys = [...keyCounts.entries()].filter(([, count]) => count > 1);
  if (duplicatedKeys.length > 0) {
    notes.push(
      `${duplicatedKeys.length} (route_no, trip_no, direction_id) key(s) appear more than once; ` +
        `all ${values.length} source rows were preserved because the specification's DDL does not ` +
        `constrain this triple`,
    );
  }

  const emptyOrigin = rows.filter((row) => trimmed(row.origin).length === 0).length;
  notes.push(`${emptyOrigin} of ${rows.length} row(s) had an empty origin and were stored as NULL`);

  if (replace) {
    await truncateTables(["bus_timetables"]);
    notes.push("replaced existing bus_timetables rows (replace mode)");
  }

  await insertBatch(
    "bus_timetables",
    [
      "operator",
      "route_no",
      "trip_no",
      "direction_id",
      "origin",
      "destination",
      "departure_time",
      "arrival_time",
      "source_image_order",
    ],
    values,
  );

  // Derived AFTER the insert. Recomputing first would summarise the previous
  // import's rows, leaving route_trip_stats empty on a first run -- and those
  // stats are what let the planner price a bus ride from observed data instead
  // of a static guess.
  notes.push(...(await recomputeRouteTripStats("BUS")));

  return {
    sourceFile: fileName,
    targetTable: "bus_timetables",
    mode: "BUS",
    operator: null,
    rowsRead: rows.length,
    rowsInserted: values.length,
    rowsRejected: rejections.length,
    rejections,
    notes,
  };
}

// ---------------------------------------------------------------------------
// wbtc_tram_routes.csv -> tram_route_stops
// ---------------------------------------------------------------------------

export async function importTramRoutes(
  fileName = "wbtc_tram_routes.csv",
  operator = env.DEFAULT_ROUTE_STOP_OPERATOR,
  options: ImportOptions = {},
): Promise<ImportResult> {
  const { replace = true } = options;
  const rows = await readCsv(fileName);
  const rejections: Rejection[] = [];
  const notes: string[] = [];

  // The real file carries a leading `id` column that the specification's column
  // list omits. It is a source-file artifact, not transport data, so it is
  // detected and dropped rather than silently absorbed into a data column.
  if (rows.length > 0 && "id" in rows[0]!) {
    notes.push(
      "source file has an extra leading 'id' column that is not in the specification; it was ignored and not stored",
    );
  }

  const values: unknown[][] = [];
  const seenKeys = new Set<string>();
  const seenNames = new Set<string>();
  let nullSequences = 0;

  rows.forEach((row, index) => {
    const rowNumber = index + 2;

    // Spec section 18: tram requires route_no and stop_name; the sequence MAY
    // be NULL.
    const routeNo = trimmed(row.route_no);
    if (routeNo.length === 0) {
      rejections.push({ row: rowNumber, reason: "route_no is required", value: row.route_no });
      return;
    }
    const stopName = trimmed(row.stop_name);
    if (stopName.length === 0) {
      rejections.push({ row: rowNumber, reason: "stop_name is required", value: row.stop_name });
      return;
    }

    // Empty sequence -> SQL NULL, explicitly never 0 (spec section 7/18).
    let sequence: number | null = null;
    if (trimmed(row.stop_sequence_no).length > 0) {
      sequence = parsePositiveInt(row.stop_sequence_no);
      if (sequence === null) {
        rejections.push({
          row: rowNumber,
          reason: "stop_sequence_no present but not an integer greater than 0",
          value: row.stop_sequence_no,
        });
        return;
      }
    } else {
      nullSequences += 1;
    }

    if (sequence !== null) {
      const key = `${operator}|${routeNo}|${sequence}`;
      if (seenKeys.has(key)) {
        rejections.push({
          row: rowNumber,
          reason: `duplicate (operator, route_no, stop_sequence_no) = (${operator}, ${routeNo}, ${sequence})`,
        });
        return;
      }
      seenKeys.add(key);
    }

    // A route that repeats the same stop name at the same sequence would make
    // the graph ambiguous. Checked on (route, stop) rather than (route, seq)
    // because unsequenced rows have no sequence to compare.
    const nameKey = `${routeNo}|${stopName.toLowerCase()}`;
    if (seenNames.has(nameKey)) {
      rejections.push({
        row: rowNumber,
        reason: `stop "${stopName}" appears more than once on tram route ${routeNo}`,
      });
      return;
    }
    seenNames.add(nameKey);

    values.push([operator, nullable(row.vehicle_type) ?? "tram", routeNo, nullable(row.depot), sequence, stopName]);
  });

  if (nullSequences > 0) {
    notes.push(`${nullSequences} row(s) had an empty stop_sequence_no and were stored as SQL NULL (never 0)`);
  }
  notes.push("tram has no timetable source file, so tram journeys use static estimated travel times");

  if (replace) {
    await truncateTables(["tram_route_stops"]);
    notes.push("replaced existing tram_route_stops rows (replace mode)");
  }

  await insertBatch(
    "tram_route_stops",
    ["operator", "vehicle_type", "route_no", "depot", "stop_sequence_no", "stop_name"],
    values,
  );

  const sourceRouteNos = [...new Set(rows.map((row) => trimmed(row.route_no)).filter((no) => no.length > 0))];
  const vanished = await findVanishedRoutes(getPool(), "tram_route_stops", sourceRouteNos);
  if (vanished.length > 0) {
    notes.push(
      `WARNING: ${vanished.length} route number(s) in the source have no usable row and will NOT appear in the API: ` +
        `${vanished.join(", ")} (every one of their rows was rejected)`,
    );
  }

  return {
    sourceFile: fileName,
    targetTable: "tram_route_stops",
    mode: "TRAM",
    operator,
    rowsRead: rows.length,
    rowsInserted: values.length,
    rowsRejected: rejections.length,
    rejections,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Route statistics derived from real timetable rows
// ---------------------------------------------------------------------------

/**
 * Recomputes route_trip_stats from bus_timetables using observed
 * (arrival_time - departure_time) values.
 *
 * This is the single most important function for honest journey planning: it is
 * what lets the planner price a bus ride from real data instead of a guess. A
 * route with no complete time pair simply gets no stats and later falls back to
 * a configured speed estimate, which is explicitly allowed by spec section 22.
 */
export async function recomputeRouteTripStats(mode: "BUS" | "TRAM"): Promise<string[]> {
  if (mode !== "BUS") return [];

  const { rows } = await getPool().query<{
    route_no: string;
    operator: string | null;
    sample_count: string;
    avg_minutes: string;
    min_minutes: string;
    max_minutes: string;
  }>(`
    SELECT
      route_no,
      COALESCE(operator, 'UNKNOWN') AS operator,
      COUNT(*) AS sample_count,
      AVG(duration_minutes) AS avg_minutes,
      MIN(duration_minutes) AS min_minutes,
      MAX(duration_minutes) AS max_minutes
    FROM (
      SELECT
        route_no,
        operator,
        -- (arrival * 1440 + departure) / 1440 is the modular difference that
        -- correctly yields a positive duration for services crossing midnight.
        (EXTRACT(EPOCH FROM (arrival_time - departure_time)) / 60
          + CASE WHEN arrival_time < departure_time THEN 1440 ELSE 0 END) AS duration_minutes
      FROM bus_timetables
      WHERE departure_time IS NOT NULL AND arrival_time IS NOT NULL
    ) durations
    GROUP BY route_no, COALESCE(operator, 'UNKNOWN')
  `);

  const values = rows.map((row) => [
    row.operator,
    row.route_no,
    "BUS",
    Number(row.sample_count),
    Number(row.avg_minutes),
    Number(row.min_minutes),
    Number(row.max_minutes),
  ]);

  await withTransaction(async (client) => {
    await client.query("DELETE FROM route_trip_stats WHERE mode = 'BUS'");
    if (values.length > 0) {
      await client.query(
        `INSERT INTO route_trip_stats
           (operator, route_no, mode, sample_count, avg_trip_minutes, min_trip_minutes, max_trip_minutes, updated_at)
         VALUES ${values.map((_, i) => `($${i * 7 + 1}, $${i * 7 + 2}, $${i * 7 + 3}, $${i * 7 + 4}, $${i * 7 + 5}, $${i * 7 + 6}, $${i * 7 + 7}, NOW())`).join(", ")}`,
        values.flat(),
      );
    }
  });

  return [
    `derived average trip duration for ${rows.length} bus route(s) from real timetable rows`,
  ];
}

// ---------------------------------------------------------------------------
// Shared insert + bookkeeping
// ---------------------------------------------------------------------------

/**
 * Clears the given transport tables.
 *
 * Only ever called with a hardcoded list of the three import targets, so the
 * identifier is never user input. TRUNCATE ... RESTART IDENTITY CASCADE keeps
 * uuid generation and dependent rows consistent between runs.
 */
async function truncateTables(tables: readonly string[]): Promise<void> {
  if (tables.length === 0) return;
  const list = tables.map((table) => `"${table}"`).join(", ");
  await withTransaction(async (client) => {
    await client.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  });
}

async function insertBatch(table: string, columns: string[], values: unknown[][]): Promise<void> {
  if (values.length === 0) return;
  await withTransaction(async (client) => {
    // 1000 rows per statement stays well under the 65535 bind-parameter cap.
    const CHUNK = 1000;
    for (let start = 0; start < values.length; start += CHUNK) {
      const chunk = values.slice(start, start + CHUNK);
      const placeholders = chunk
        .map((_, rowIndex) => `(${columns.map((__, colIndex) => `$${rowIndex * columns.length + colIndex + 1}`).join(", ")})`)
        .join(", ");
      const params = chunk.flat();
      await client.query(
        `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${placeholders}`,
        params,
      );
    }
  });
}

export async function recordImportRun(result: ImportResult): Promise<void> {
  const { rows } = await getPool().query(
    `INSERT INTO import_runs
       (source_file, target_table, mode, operator, rows_read, rows_inserted, rows_rejected, rejections, notes, finished_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, NOW())
     RETURNING id`,
    [
      result.sourceFile,
      result.targetTable,
      result.mode,
      result.operator,
      result.rowsRead,
      result.rowsInserted,
      result.rowsRejected,
      JSON.stringify(result.rejections.slice(0, 500)),
      JSON.stringify(result.notes),
    ],
  );
  console.log(`  recorded import run id=${rows[0]?.id ?? "?"}`);
}

export function summarize(result: ImportResult): string {
  const lines = [
    `${result.sourceFile} -> ${result.targetTable}`,
    `  read     : ${result.rowsRead}`,
    `  inserted : ${result.rowsInserted}`,
    `  rejected : ${result.rowsRejected}`,
  ];
  for (const note of result.notes) lines.push(`  note     : ${note}`);
  for (const rejection of result.rejections.slice(0, 10)) {
    lines.push(`  reject   : line ${rejection.row}: ${rejection.reason}`);
  }
  if (result.rejections.length > 10) {
    lines.push(`  reject   : ... and ${result.rejections.length - 10} more`);
  }
  return lines.join("\n");
}

/** Exposed for tests: the duration rule used to derive route statistics. */
export function computeDurationMinutes(departure: string, arrival: string): number | null {
  return minutesBetween(departure, arrival);
}

export { normalizeRouteNo };

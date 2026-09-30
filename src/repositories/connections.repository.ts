import { query } from "../config/database.js";

/**
 * Cross-mode service windows and interchange platforms.
 *
 * This answers a question the per-mode endpoints cannot: when a rider looks up
 * one route, which other lines can they reach from it, and what are the first
 * and last services on each of those lines in the direction of travel.
 *
 * Two rules shape everything here.
 *
 * 1. A bus stop is linked to a metro station by NAME, because the data set has
 *    no shared key between bus stops and metro stations. Names are normalised
 *    and a trailing parenthetical is also tried on its own, because stops like
 *    "Vivekananda Road (Girish Park)" name a metro station in the bracket. A
 *    name match is still only a name match, so the response says so rather than
 *    presenting the pairing as surveyed fact.
 *
 * 2. Platform numbers are only ever returned as the data set states them, with
 *    their verification status attached. The set flags real disagreement with
 *    SOURCE_CONFLICT, and a conflicted platform number is the one case where
 *    guessing would be worst: it sends a passenger to the wrong side of a
 *    station. Conflicted and inferred rows are returned, but marked, and the
 *    caller is told not to rely on them.
 */

/** Rows whose verification status means "do not present this as certain". */
const UNVERIFIED_PLATFORM_STATUSES = new Set(["INFERRED_DIRECTION_PLATFORM", "SOURCE_CONFLICT"]);

export interface ServiceWindow {
  /** First departure in the direction of travel, HH:MM. */
  firstDeparture: string | null;
  /** Last arrival in the direction of travel, HH:MM. */
  lastArrival: string | null;
  /** Headway in minutes when published, otherwise null. */
  frequencyMinutes: number | null;
  /** How the window was derived, so a caller can tell published from computed. */
  source: "TIMETABLE" | "PUBLISHED_HEADWAY" | "NONE";
  /** Whether the value differs by service day, which Metro rows do. */
  variesByServiceDay: boolean;
}

export interface MetroPlatform {
  stationCode: string;
  stationName: string;
  line: string;
  platformNumber: string;
  /** Terminus the train runs toward, as recorded in the data set. */
  towards: string | null;
  direction: string | null;
  status: string;
  verificationStatus: string;
  /** True when the number should not be presented as settled fact. */
  unverified: boolean;
  sourceNote: string | null;
}

export interface MetroLineWindow {
  mode: "METRO";
  line: string;
  lineName: string;
  /** One entry per direction, so the caller can pick the useful one. */
  directions: Array<{
    direction: string;
    originStationName: string | null;
    destinationStationName: string | null;
    window: ServiceWindow;
  }>;
  /** Platforms at the interchange station where this line meets the route. */
  platforms: MetroPlatform[];
  /** True when at least one platform below is unverified or conflicted. */
  platformWarning: string | null;
}

export interface FerryTramWindow {
  mode: "FERRY" | "TRAM";
  routeId: string;
  routeName: string;
  operator: string;
  window: ServiceWindow;
}

export interface RouteConnections {
  route: {
    mode: "BUS" | "METRO" | "FERRY" | "TRAM";
    routeNo: string;
    routeName: string | null;
    operator: string | null;
  };
  /** The searched route's own service window, when it has one. */
  routeWindow: ServiceWindow | null;
  /** Metro lines reachable from a stop on this route, keyed by line. */
  metroLines: MetroLineWindow[];
  /** Ferry and tram services reachable from a stop on this route. */
  otherServices: FerryTramWindow[];
  /** How the route-to-station pairing was made. */
  matching: {
    method: "STOP_NAME_MATCH";
    note: string;
    matchedStations: number;
  };
}

interface Row {
  [column: string]: unknown;
}

/**
 * Every name to try for one stop.
 *
 * "Vivekananda Road (Girish Park)" yields the full string, the name with the
 * bracket stripped, and the bracket text on its own, because the bracket is
 * where the metro station name usually hides: a bus stop is written
 * "Vivekananda Road (Girish Park)" and the station is signed "Girish Park".
 *
 * This lives here rather than in SQL so there is one copy of the rule and it can
 * be tested without a database. The query below takes the expanded list.
 */
export function stopNameCandidates(rawName: string): string[] {
  const base = rawName.trim().replace(/\s+/g, " ");
  const withoutBracket = base.replace(/\s*\([^()]*\)\s*$/, "").trim();
  const bracketOnly = base.match(/\(([^()]*)\)/);

  const candidates = new Set<string>();
  const add = (value: string | null | undefined): void => {
    const cleaned = value?.trim().replace(/\s+/g, " ");
    if (cleaned) candidates.add(cleaned);
  };
  add(base);
  add(withoutBracket);
  add(bracketOnly?.[1]);
  return [...candidates];
}

/** Lower-cases a name for comparison, matching the SQL side of the join. */
function normalise(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

const toHHMM = (value: string | Date | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.slice(0, 5);
  const date = value as Date;
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(11, 16);
};

const toNumber = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Metro first and last per line and direction.
 *
 * MIN(departure_time) and MAX(arrival_time) are taken across every service day
 * in the data set. That is the widest possible window, so a passenger told
 * "first at 06:00" is never told too late. The result varies by service day, so
 * variesByServiceDay says so rather than implying one schedule covers all days.
 */
async function loadMetroWindows(lines: string[]): Promise<Map<string, MetroLineWindow>> {
  const byLine = new Map<string, MetroLineWindow>();
  if (lines.length === 0) return byLine;

  const rows = await query<Row>(
    `SELECT r.line,
            r.line_name,
            t.direction,
            MIN(t.departure_time)      AS first_departure,
            MAX(t.arrival_time)        AS last_arrival,
            COUNT(*)::int              AS trip_count,
            COUNT(DISTINCT t.service_day)::int AS service_days,
            (ARRAY_AGG(t.origin_station_name      ORDER BY t.departure_time ASC))[1] AS origin_name,
            (ARRAY_AGG(t.destination_station_name ORDER BY t.departure_time DESC))[1] AS destination_name
       FROM metro_trips t
       JOIN metro_routes r ON r.line = t.line
      WHERE r.line = ANY($1::text[])
        AND t.departure_time IS NOT NULL
      GROUP BY r.line, r.line_name, t.direction
      ORDER BY r.line, t.direction`,
    [lines],
  );

  for (const row of rows as Array<Record<string, unknown>>) {
    const line = String(row.line);
    const existing = byLine.get(line) ?? {
      mode: "METRO" as const,
      line,
      lineName: String(row.line_name ?? line),
      directions: [],
      platforms: [],
      platformWarning: null,
    };
    existing.directions.push({
      direction: String(row.direction ?? "UNKNOWN"),
      // Station names, not times: these must not go through the time formatter.
      originStationName: (row.origin_name as string) ?? null,
      destinationStationName: (row.destination_name as string) ?? null,
      window: {
        firstDeparture: toHHMM(row.first_departure as string),
        lastArrival: toHHMM(row.last_arrival as string),
        frequencyMinutes: null,
        source: "TIMETABLE" as const,
        variesByServiceDay: Number(row.service_days ?? 1) > 1,
      },
    });
    existing.directions.sort((a, b) => a.direction.localeCompare(b.direction));
    byLine.set(line, existing);
  }
  return byLine;
}

/**
 * Platforms for the given lines, restricted to the stations this route meets.
 *
 * The join is on (station_code, line) rather than station name alone, because
 * platform numbering is a property of a line at a station: at Esplanade the
 * Blue and Green platforms are numbered independently and the same number means
 * different physical platforms on each line.
 */
async function loadPlatforms(
  line: string,
  stationCodes: string[],
): Promise<MetroPlatform[]> {
  if (stationCodes.length === 0) return [];
  const rows = await query<Row>(
    `SELECT station_code, station_name, line, platform_number, towards, direction, status,
            verification_status, source_note
       FROM metro_station_platforms
      WHERE line = $1
        AND station_code = ANY($2::text[])
      ORDER BY station_code, platform_number`,
    [line, stationCodes],
  );

  return (rows as Row[]).map((row) => {
    const verificationStatus = String(row.verification_status ?? "UNKNOWN");
    return {
      stationCode: String(row.station_code),
      stationName: String(row.station_name),
      line: String(row.line),
      platformNumber: String(row.platform_number),
      towards: (row.towards as string) ?? null,
      direction: (row.direction as string) ?? null,
      status: String(row.status ?? "UNKNOWN"),
      verificationStatus,
      unverified: UNVERIFIED_PLATFORM_STATUSES.has(verificationStatus),
      sourceNote: (row.source_note as string) ?? null,
    };
  });
}

/** Human-readable warning when a platform number should not be trusted blindly. */
function platformWarningFor(platforms: MetroPlatform[]): string | null {
  if (platforms.length === 0) {
    return "No platform numbering is recorded for this line at this interchange.";
  }
  const conflicts = platforms.filter((p) => p.verificationStatus === "SOURCE_CONFLICT");
  if (conflicts.length > 0) {
    const stations = [...new Set(conflicts.map((p) => p.stationName))].join(", ");
    return (
      `Public sources disagree on platform numbering at ${stations}. ` +
      "The number shown is the best available value and may be wrong; confirm on the station signage."
    );
  }
  const inferred = platforms.filter((p) => p.verificationStatus === "INFERRED_DIRECTION_PLATFORM");
  if (inferred.length > 0) {
    return (
      "Platform numbers on this leg were inferred from line order rather than independently " +
      "verified. Treat them as a guide, not a guarantee."
    );
  }
  return null;
}

/** The route's own service window, per mode. */
async function loadRouteWindow(
  mode: "BUS" | "METRO" | "FERRY" | "TRAM",
  routeNo: string,
): Promise<ServiceWindow | null> {
  if (mode === "BUS") {
    const rows = await query<Row>(
      `SELECT MIN(departure_time) AS first_departure,
              MAX(arrival_time)   AS last_arrival
         FROM bus_timetables
        WHERE UPPER(TRIM(route_no)) = UPPER(TRIM($1))`,
      [routeNo],
    );
    const row = rows[0] as Row | undefined;
    if (!row || (!row.first_departure && !row.last_arrival)) return null;
    return {
      firstDeparture: toHHMM(row.first_departure as string),
      lastArrival: toHHMM(row.last_arrival as string),
      frequencyMinutes: null,
      source: "TIMETABLE",
      variesByServiceDay: false,
    };
  }

  if (mode === "FERRY") {
    const rows = await query<Row>(
      `SELECT first_departure, last_departure, frequency_minutes
         FROM ferry_routes
        WHERE UPPER(TRIM(route_id)) = UPPER(TRIM($1))
           OR UPPER(TRIM(route_name)) = UPPER(TRIM($1))`,
      [routeNo],
    );
    const row = rows[0] as Row | undefined;
    if (!row) return null;
    return {
      firstDeparture: toHHMM(row.first_departure as string),
      // A ferry has no arrival column, so the last departure stands as the last
      // point at which the service can be caught.
      lastArrival: toHHMM(row.last_departure as string),
      frequencyMinutes: toNumber(row.frequency_minutes),
      source: row.first_departure ? "PUBLISHED_HEADWAY" : "NONE",
      variesByServiceDay: false,
    };
  }

  if (mode === "TRAM") {
    const rows = await query<Row>(
      `SELECT s.first_departure, s.last_departure, s.frequency_minutes
         FROM tram_services s
         JOIN tram_routes r ON r.route_id = s.route_id
        WHERE UPPER(TRIM(r.route_id)) = UPPER(TRIM($1))
           OR UPPER(TRIM(r.route_no)) = UPPER(TRIM($1))`,
      [routeNo],
    );
    const row = rows[0] as Row | undefined;
    if (!row) return null;
    return {
      firstDeparture: toHHMM(row.first_departure as string),
      lastArrival: toHHMM(row.last_departure as string),
      frequencyMinutes: toNumber(row.frequency_minutes),
      source: row.first_departure ? "PUBLISHED_HEADWAY" : "NONE",
      variesByServiceDay: false,
    };
  }

  // METRO: the route number is a line.
  const rows = await query<Row>(
    `SELECT MIN(t.departure_time) AS first_departure,
            MAX(t.arrival_time)   AS last_arrival
       FROM metro_trips t
      WHERE UPPER(TRIM(t.line)) = UPPER(TRIM($1))`,
    [routeNo],
  );
  const row = rows[0] as Row | undefined;
  if (!row || (!row.first_departure && !row.last_arrival)) return null;
  return {
    firstDeparture: toHHMM(row.first_departure as string),
    lastArrival: toHHMM(row.last_arrival as string),
    frequencyMinutes: null,
    source: "TIMETABLE",
    variesByServiceDay: true,
  };
}

/**
 * Metro stations reached from a set of stop names, grouped by line.
 *
 * A stop name is expanded into its candidates, then matched against
 * metro_stations on the normalised name. Matching is case-insensitive so
 * "esplanade" and "Esplanade" are the same station.
 */
async function findMetroStationsForNames(
  names: string[],
): Promise<Array<{ line: string; stationCode: string; stationName: string }>> {
  if (names.length === 0) return [];
  // Expanded in TypeScript so the bracketed-name rule has a single home.
  const candidates = [...new Set(names.flatMap(stopNameCandidates))].filter(Boolean);
  if (candidates.length === 0) return [];

  const rows = await query<Row>(
    `SELECT DISTINCT s.line,
                     s.station_code AS "stationCode",
                     s.station_name AS "stationName"
       FROM unnest($1::text[]) AS c(name)
       JOIN metro_stations s
         ON lower(regexp_replace(trim(s.station_name), '\\s+', ' ', 'g')) = lower(trim(c.name))
      ORDER BY s.line, s.station_code`,
    [candidates],
  );
  return rows as Array<{ line: string; stationCode: string; stationName: string }>;
}

/** Ferry and tram services reachable from a set of stop or ghat names. */
async function findFerryAndTram(names: string[], exclude: string): Promise<FerryTramWindow[]> {
  if (names.length === 0) return [];
  const out: FerryTramWindow[] = [];
  // A route is not a connection to itself. The caller passes what the rider
  // searched for, which may be the id, the number or the name, so all three are
  // compared rather than assuming one.
  const isSelf = (row: Row): boolean => {
    const wanted = normalise(exclude);
    return (
      normalise(String(row.route_id ?? "")) === wanted ||
      normalise(String(row.route_name ?? "")) === wanted
    );
  };

  const ferry = await query<Row>(
    `SELECT DISTINCT r.route_id, r.route_name, r.operator,
            r.first_departure, r.last_departure, r.frequency_minutes
       FROM ferry_routes r
       JOIN ferry_legs l ON l.route_id = r.route_id
      WHERE lower(regexp_replace(trim(r.from_ghat), '\\s+', ' ', 'g')) = ANY($1::text[])
         OR lower(regexp_replace(trim(r.to_ghat), '\\s+', ' ', 'g')) = ANY($1::text[])
      ORDER BY r.route_id`,
    [names.map(normalise)],
  );
  for (const row of ferry as Row[]) {
    if (isSelf(row)) continue;
    out.push({
      mode: "FERRY",
      routeId: String(row.route_id),
      routeName: String(row.route_name ?? row.route_id),
      operator: String(row.operator ?? ""),
      window: {
        firstDeparture: toHHMM(row.first_departure as string),
        lastArrival: toHHMM(row.last_departure as string),
        frequencyMinutes: toNumber(row.frequency_minutes),
        source: row.first_departure ? "PUBLISHED_HEADWAY" : "NONE",
        variesByServiceDay: false,
      },
    });
  }

  const tram = await query<Row>(
    `SELECT DISTINCT t.route_id, t.route_name, t.operator,
            s.first_departure, s.last_departure, s.frequency_minutes
       FROM tram_routes t
       JOIN tram_services s ON s.route_id = t.route_id
      WHERE lower(regexp_replace(trim(t.from_terminal), '\\s+', ' ', 'g')) = ANY($1::text[])
         OR lower(regexp_replace(trim(t.to_terminal), '\\s+', ' ', 'g')) = ANY($1::text[])
      ORDER BY t.route_id`,
    [names.map(normalise)],
  );
  for (const row of tram as Row[]) {
    if (isSelf(row)) continue;
    out.push({
      mode: "TRAM",
      routeId: String(row.route_id),
      routeName: String(row.route_name ?? row.route_id),
      operator: String(row.operator ?? ""),
      window: {
        firstDeparture: toHHMM(row.first_departure as string),
        lastArrival: toHHMM(row.last_departure as string),
        frequencyMinutes: toNumber(row.frequency_minutes),
        source: row.first_departure ? "PUBLISHED_HEADWAY" : "NONE",
        variesByServiceDay: false,
      },
    });
  }

  return out;
}

/**
 * GET /api/routes/:routeNo/connections
 *
 * Resolves one route, then reports what else can be caught from it and when
 * those services run.
 */
export async function getRouteConnections(
  mode: "BUS" | "METRO" | "FERRY" | "TRAM",
  routeNo: string,
): Promise<RouteConnections | null> {
  const stops = await loadStopNames(mode, routeNo);
  const stopNames = stops.map((s) => s.name);

  const routeWindow = await loadRouteWindow(mode, routeNo);

  // A route may be known only by its timetable, or only by its stops: in this
  // data set most bus route numbers appear in one table and not the other. Both
  // count as existing. Only a route in neither table is a genuine miss, and
  // reporting that as "no connections" would be a lie -- a route that runs every
  // 10 minutes and meets no metro is a real answer, not a missing one.
  if (stops.length === 0 && routeWindow === null) return null;

  const stations = await findMetroStationsForNames(stopNames);
  const lines = [...new Set(stations.map((s) => s.line))];
  const windows = await loadMetroWindows(lines);

  const metroLines: MetroLineWindow[] = [];
  for (const line of lines) {
    const entry = windows.get(line);
    if (!entry) continue;
    const codesForLine = stations.filter((s) => s.line === line).map((s) => s.stationCode);
    entry.platforms = await loadPlatforms(line, codesForLine);
    entry.platformWarning = platformWarningFor(entry.platforms);
    metroLines.push(entry);
  }
  metroLines.sort((a, b) => a.line.localeCompare(b.line));

  return {
    route: {
      mode,
      routeNo,
      routeName: stops[0]?.routeName ?? null,
      operator: stops[0]?.operator ?? null,
    },
    routeWindow,
    metroLines,
    otherServices: await findFerryAndTram(stopNames, routeNo),
    matching: {
      method: "STOP_NAME_MATCH",
      note:
        "Bus stops and metro stations share no key in the data set, so lines are matched by " +
        "normalised station name, including a trailing parenthetical where the station name is " +
        "given in brackets. A match is a name match, not a surveyed interchange. Zero matches " +
        "means this route meets no metro station in the data, not that it never does.",
      matchedStations: new Set(stations.map((s) => `${s.line}|${s.stationCode}`)).size,
    },
  };
}

interface LoadedStop {
  name: string;
  routeName: string | null;
  operator: string | null;
}

/** Stop or ghat names on a route, which is what the name matching runs over. */
async function loadStopNames(
  mode: "BUS" | "METRO" | "FERRY" | "TRAM",
  routeNo: string,
): Promise<LoadedStop[]> {
  if (mode === "BUS") {
    const rows = await query<Row>(
      `SELECT stop_name AS name, depot AS route_name, operator
         FROM bus_route_stops
        WHERE UPPER(TRIM(route_no)) = UPPER(TRIM($1))
        ORDER BY stop_sequence_no`,
      [routeNo],
    );
    return rows as unknown as LoadedStop[];
  }

  if (mode === "METRO") {
    const rows = await query<Row>(
      `SELECT station_name AS name, line AS route_name, line AS operator
         FROM metro_stations
        WHERE UPPER(TRIM(line)) = UPPER(TRIM($1))
        ORDER BY station_sequence`,
      [routeNo],
    );
    return rows as unknown as LoadedStop[];
  }

  if (mode === "FERRY") {
    // The terminals alone are not the route. A ferry that runs Babughat to
    // Howrah and touches Prinsep Ghat on the way is connectable at Prinsep
    // Ghat, so every leg endpoint is loaded, not just the first and last stop.
    const rows = await query<Row>(
      `SELECT l.from_ghat AS name, r.route_name, r.operator
         FROM ferry_legs l
         JOIN ferry_routes r ON r.route_id = l.route_id
        WHERE UPPER(TRIM(r.route_id)) = UPPER(TRIM($1))
           OR UPPER(TRIM(r.route_name)) = UPPER(TRIM($1))
       UNION
       SELECT l.to_ghat AS name, r.route_name, r.operator
         FROM ferry_legs l
         JOIN ferry_routes r ON r.route_id = l.route_id
        WHERE UPPER(TRIM(r.route_id)) = UPPER(TRIM($1))
           OR UPPER(TRIM(r.route_name)) = UPPER(TRIM($1))
       UNION
       SELECT r.from_ghat AS name, r.route_name, r.operator FROM ferry_routes r
        WHERE UPPER(TRIM(r.route_id)) = UPPER(TRIM($1))
           OR UPPER(TRIM(r.route_name)) = UPPER(TRIM($1))
       UNION
       SELECT r.to_ghat AS name, r.route_name, r.operator FROM ferry_routes r
        WHERE UPPER(TRIM(r.route_id)) = UPPER(TRIM($1))
           OR UPPER(TRIM(r.route_name)) = UPPER(TRIM($1))`,
      [routeNo],
    );
    return rows as unknown as LoadedStop[];
  }

  const rows = await query<Row>(
    `SELECT l.from_stop AS name, t.route_name, t.operator
       FROM tram_legs l
       JOIN tram_routes t ON t.route_id = l.route_id
      WHERE UPPER(TRIM(t.route_id)) = UPPER(TRIM($1))
         OR UPPER(TRIM(t.route_no)) = UPPER(TRIM($1))
         OR UPPER(TRIM(t.route_name)) = UPPER(TRIM($1))
     UNION
     SELECT l.to_stop AS name, t.route_name, t.operator
       FROM tram_legs l
       JOIN tram_routes t ON t.route_id = l.route_id
      WHERE UPPER(TRIM(t.route_id)) = UPPER(TRIM($1))
         OR UPPER(TRIM(t.route_no)) = UPPER(TRIM($1))
         OR UPPER(TRIM(t.route_name)) = UPPER(TRIM($1))
     UNION
     SELECT s.stop_name AS name, t.route_name, t.operator
       FROM tram_stops s
       JOIN tram_routes t ON t.route_id = s.route_id
      WHERE UPPER(TRIM(t.route_id)) = UPPER(TRIM($1))
         OR UPPER(TRIM(t.route_no)) = UPPER(TRIM($1))
         OR UPPER(TRIM(t.route_name)) = UPPER(TRIM($1))`,
    [routeNo],
  );
  return rows as unknown as LoadedStop[];
}

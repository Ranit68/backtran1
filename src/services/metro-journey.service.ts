import { getAllMetroStations, listMetroLines } from "../repositories/metro.repository.js";
import { getGraph } from "./graph.service.js";
import { getJourneyService, type JourneyOptions } from "./journey.service.js";
import { env } from "../config/env.js";
import type { MetroStationRow } from "../models/metro.model.js";
import type {
  JourneySegment,
  MetroInterchange,
  MetroJourneyResponse,
  MetroNetworkInterchange,
  MetroNetworkLine,
  MetroNetworkResponse,
  MetroPlatformInfo,
  MetroUnreachable,
} from "../types/transport.js";

/**
 * Metro-only planning.
 *
 * Two things separate this from the generic planner, and both come from what a
 * Metro passenger needs to know rather than from the transport graph:
 *
 *  1. A journey is reported as a sequence of lines, not an undifferentiated list
 *     of legs. A change of line is the single most important fact in a Metro
 *     trip, and the generic response only implies it.
 *  2. Every change is broken out with the line being left, the line being
 *     joined, and the terminus each train runs toward.
 *
 * What this service deliberately does not do is invent a platform number. The
 * supplied Metro data has lines, stations, station codes and station order, and
 * no platform numbering, so a platform is reported as unknown with the reason
 * attached. The terminus a train runs toward is the real, derived equivalent: it
 * is what a passenger uses to pick the right train at an interchange, and unlike
 * a platform number it follows from the data.
 *
 * Planning itself is delegated to the shared journey service with `mode: "METRO"`
 * rather than reimplemented, so the Metro view and the generic view can never
 * disagree about which route is faster or what a leg costs.
 */

const PLATFORM_NOTE =
  "The supplied Metro data records lines, stations, station codes and station order, " +
  "but no platform numbers. Platform numbers are therefore reported as unknown rather " +
  "than guessed: use the line name and the destination terminus to find the right platform.";

interface LineInfo {
  line: string;
  /** Station names in line order, taken from the graph the pathfinder walks. */
  stops: string[];
}

interface NetworkIndex {
  lines: Map<string, LineInfo>;
  /** Station name -> every line serving it. */
  linesAtStation: Map<string, string[]>;
  /** Station name -> code, across all lines. Null where the source has none. */
  codeByStation: Map<string, string | null>;
  interchanges: MetroNetworkInterchange[];
  components: { id: number; lines: string[] }[];
  componentOfLine: Map<string, number>;
  isolatedLines: string[];
}

type RideSegment = JourneySegment & { routeNo: string };

export class MetroJourneyService {
  /**
   * Plans a Metro-only journey and reports the lines and interchanges in detail.
   *
   * `departureTime` and `strategy` behave exactly as they do on the generic
   * planner, because the underlying plan is the same one.
   */
  async plan(
    request: JourneyOptions & { source: string; destination: string },
  ): Promise<MetroJourneyResponse> {
    const index = await this.loadNetworkIndex();
    const base = await getJourneyService().plan({ ...request, mode: "METRO" });

    const rides = base.segments.filter(
      (segment): segment is RideSegment => segment.mode === "METRO" && typeof segment.routeNo === "string",
    );

    const linesUsed: string[] = [];
    for (const ride of rides) {
      if (linesUsed[linesUsed.length - 1] !== ride.routeNo) linesUsed.push(ride.routeNo);
    }

    const interchanges = this.buildInterchanges(rides, index);
    // Every station strictly between a leg's two ends. An interchange station is
    // an endpoint of both adjoining legs, so it is correctly excluded here.
    const stationsPassed = rides.reduce((sum, ride) => sum + Math.max(0, (ride.stops?.length ?? 1) - 1), 0);

    const response: MetroJourneyResponse = {
      source: base.source,
      destination: base.destination,
      totalTimeMinutes: base.totalTimeMinutes,
      // Taken from the interchanges actually found, so the count can never drift
      // from the array the caller reads.
      interchangeCount: interchanges.length,
      linesUsed,
      stationsPassed,
      segments: base.segments,
      interchanges,
      strategy: base.strategy,
      timetableMatched: base.timetableMatched,
      warnings: base.warnings,
    };

    if (rides.length === 0) {
      response.unreachable = this.explainUnreachable(request.source, request.destination, index);
    }

    return response;
  }

  /**
   * The Metro network as the planner sees it: every line, every interchange, and
   * an explicit statement of which lines can reach which.
   *
   * This exists because "the lines are connected" is a property of the data that
   * has to be checkable. A line sharing no station with any other line is
   * unreachable for a Metro-only journey, and reporting it as an isolated
   * component is far more useful than letting the planner simply fail.
   */
  async network(): Promise<MetroNetworkResponse> {
    const index = await this.loadNetworkIndex();

    // Display data comes from the database so the reported names and counts are
    // the ones the source recorded, not ones derived from the graph.
    let display = new Map<string, { name: string | null; trips: number }>();
    try {
      const rows = await listMetroLines({ limit: 100, offset: 0 });
      display = new Map(rows.map((row) => [row.line, { name: row.line_name, trips: row.trip_count }]));
    } catch {
      // No database: fall back to the line code alone. The connectivity report
      // comes from the graph and is unaffected.
    }

    const lines: MetroNetworkLine[] = [...index.lines.values()]
      .map((info) => {
        const component = index.componentOfLine.get(info.line) ?? 0;
        return {
          line: info.line,
          name: display.get(info.line)?.name ?? null,
          stationCount: info.stops.length,
          firstStop: info.stops[0] ?? null,
          lastStop: info.stops[info.stops.length - 1] ?? null,
          stationsWithCode: this.countCodedStations(info, index),
          hasTimetable: (display.get(info.line)?.trips ?? 0) > 0,
          // Connected means reachable from the main group, not merely "not alone".
          connected: index.components.length === 1,
          component,
        };
      })
      .sort((a, b) => a.line.localeCompare(b.line));

    const allConnected = index.isolatedLines.length === 0 && index.components.length === 1;
    const note = allConnected
      ? "Every line shares at least one station with the rest of the network, so any station can be reached from any other using Metro alone."
      : `${index.isolatedLines.join(", ")} ${
          index.isolatedLines.length === 1 ? "shares" : "share"
        } no station with any other line in the supplied data, so ${
          index.isolatedLines.length === 1 ? "it is" : "they are"
        } unreachable from the rest of the network by Metro alone. Reaching ${
          index.isolatedLines.length === 1 ? "it" : "them"
        } needs a surface connection, which this Metro-only planner does not model.`;

    return {
      lines,
      interchanges: index.interchanges,
      connectivity: {
        allLinesConnected: allConnected,
        componentCount: index.components.length,
        isolatedLines: index.isolatedLines,
        components: index.components,
        note,
      },
      platformData: { available: false, note: PLATFORM_NOTE },
    };
  }

  /**
   * A change of line between two consecutive ride legs.
   *
   * Consecutive legs on the same line are one ride rather than an interchange, so
   * a change is only reported when the line actually differs. The direction each
   * train runs toward comes from the line's own station order, so it is real
   * data rather than a guess about which way a platform faces.
   */
  private buildInterchanges(rides: RideSegment[], index: NetworkIndex): MetroInterchange[] {
    const interchanges: MetroInterchange[] = [];

    for (let i = 0; i < rides.length - 1; i += 1) {
      const arriving = rides[i]!;
      const departing = rides[i + 1]!;
      if (arriving.routeNo === departing.routeNo) continue;

      const station = arriving.to;
      const fromLine = arriving.routeNo;
      const toLine = departing.routeNo;
      const fromDirection = this.directionToward(index, fromLine, arriving.from, station);
      const toDirection = this.directionToward(index, toLine, station, departing.to);
      const platforms: MetroPlatformInfo = { known: false, note: PLATFORM_NOTE };

      const interchange: MetroInterchange = {
        station,
        stationCode: index.codeByStation.get(station) ?? null,
        linesAtStation: index.linesAtStation.get(station) ?? [fromLine, toLine],
        fromLine,
        toLine,
        fromDirection,
        toDirection,
        interchangeMinutes: env.MIN_INTERCHANGE_MINUTES,
        platforms,
        instruction:
          `Change at ${station} from the ${fromLine} line` +
          (fromDirection ? ` towards ${fromDirection}` : "") +
          ` to the ${toLine} line` +
          (toDirection ? ` towards ${toDirection}` : "") +
          ".",
      };

      // Only when the timetable actually printed them, so a caller cannot
      // mistake a projected time for a scheduled one.
      if (typeof arriving.arrivalTime === "string") interchange.fromArrivalTime = arriving.arrivalTime;
      if (typeof departing.departureTime === "string") interchange.toDepartureTime = departing.departureTime;

      interchanges.push(interchange);
    }

    return interchanges;
  }

  /**
   * The terminus a train is heading toward when it runs between two stations.
   *
   * Taken from the line's station order: travelling towards a later station
   * means the train is heading for the last stop, and vice versa. Null when
   * either station is not on the line, which is the case for a map-only station.
   */
  private directionToward(index: NetworkIndex, line: string, from: string, to: string): string | null {
    const info = index.lines.get(line);
    if (!info || info.stops.length === 0) return null;
    const fromIndex = info.stops.indexOf(from);
    const toIndex = info.stops.indexOf(to);
    if (fromIndex === -1 || toIndex === -1) return null;
    return toIndex > fromIndex ? (info.stops[info.stops.length - 1] ?? null) : (info.stops[0] ?? null);
  }

  private countCodedStations(info: LineInfo, index: NetworkIndex): number {
    let count = 0;
    for (const stop of info.stops) {
      if (index.codeByStation.get(stop)) count += 1;
    }
    return count;
  }

  /**
   * Why there is no Metro-only route, stated in terms of lines.
   *
   * A bare "no route found" leaves the caller with nothing to act on. Naming the
   * lines at each end and the isolated lines is what makes the answer usable, and
   * it is the common case for this endpoint: a station on a line that shares
   * nothing with the rest of the network is simply not reachable by Metro.
   */
  private explainUnreachable(source: string, destination: string, index: NetworkIndex): MetroUnreachable {
    const sourceLines = this.linesNear(index, source);
    const destinationLines = this.linesNear(index, destination);

    const touchingIsolated = [...new Set([...sourceLines, ...destinationLines])].filter((line) =>
      index.isolatedLines.includes(line),
    );

    const reason =
      touchingIsolated.length > 0
        ? `${touchingIsolated.join(", ")} ${
            touchingIsolated.length === 1 ? "is" : "are"
          } not connected to the rest of the Metro network in the supplied data: ${
            touchingIsolated.length === 1 ? "it shares" : "they share"
          } no station with any other line. Reaching ${
            touchingIsolated.length === 1 ? "it" : "them"
          } needs a surface connection, which this Metro-only planner does not model.`
        : `No chain of Metro lines connects ${source} to ${destination}. The lines serving these two places are ${
            sourceLines.length > 0 ? sourceLines.join(", ") : "none"
          } and ${destinationLines.length > 0 ? destinationLines.join(", ") : "none"}, and they do not meet at any interchange.`;

    return { sourceLines, destinationLines, isolatedLines: index.isolatedLines, reason };
  }

  /** Lines serving a station, matched loosely enough for a partially typed name. */
  private linesNear(index: NetworkIndex, place: string): string[] {
    const wanted = place.trim().toLowerCase();
    const direct = index.linesAtStation.get(wanted);
    if (direct) return [...direct];

    const matches = new Set<string>();
    for (const [station, lines] of index.linesAtStation) {
      if (station.includes(wanted) || wanted.includes(station)) {
        for (const line of lines) matches.add(line);
      }
    }
    return [...matches].sort();
  }

  /**
   * Builds the line/station view the planner actually runs on.
   *
   * The graph is the source of truth for line order and connectivity, because it
   * is the same structure the pathfinder walks: a line the graph cannot reach is
   * a line the planner cannot route across. Station codes come from the database,
   * since the graph does not carry them. A database failure costs the codes and
   * the display names only, never the lines.
   */
  private async loadNetworkIndex(): Promise<NetworkIndex> {
    const graph = await getGraph();

    const lines = new Map<string, LineInfo>();
    for (const route of graph.data.routes.values()) {
      if (route.mode !== "METRO") continue;
      lines.set(route.routeNo, { line: route.routeNo, stops: [...route.stopNames] });
    }

    const linesAtStation = new Map<string, string[]>();
    for (const [line, info] of lines) {
      for (const stop of info.stops) {
        const bucket = linesAtStation.get(stop);
        if (bucket) {
          if (!bucket.includes(line)) bucket.push(line);
        } else {
          linesAtStation.set(stop, [line]);
        }
      }
    }

    const codeByStation = new Map<string, string | null>();
    try {
      const rows: MetroStationRow[] = await getAllMetroStations();
      for (const row of rows) {
        // First writer wins so a code present on one line is not blanked by a
        // null from another line serving the same station.
        if (!codeByStation.has(row.station_name)) codeByStation.set(row.station_name, row.station_code);
      }
    } catch {
      // No database: codes stay absent. Planning is unaffected.
    }

    const interchanges: MetroNetworkInterchange[] = [];
    for (const [station, served] of linesAtStation) {
      if (served.length < 2) continue;
      interchanges.push({ station, stationCode: codeByStation.get(station) ?? null, lines: [...served].sort() });
    }
    interchanges.sort((a, b) => a.station.localeCompare(b.station));

    const { components, componentOfLine, isolatedLines } = groupLines(linesAtStation, [...lines.keys()]);

    return { lines, linesAtStation, codeByStation, interchanges, components, componentOfLine, isolatedLines };
  }
}

/**
 * Groups lines into connected components.
 *
 * Two lines are in the same component when they share a station, because that is
 * the only way to change between them without leaving the network. A line in a
 * component of its own is unreachable from every other line, which is exactly
 * the condition the network view has to surface.
 */
function groupLines(
  linesAtStation: Map<string, string[]>,
  allLines: string[],
): { components: { id: number; lines: string[] }[]; componentOfLine: Map<string, number>; isolatedLines: string[] } {
  const parent = new Map<string, string>(allLines.map((line) => [line, line]));
  const find = (line: string): string => {
    let current = line;
    while (parent.get(current) !== current) {
      const next = parent.get(current)!;
      parent.set(current, parent.get(next) ?? next);
      current = next;
    }
    return current;
  };
  const union = (a: string, b: string): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootA, rootB);
  };

  for (const served of linesAtStation.values()) {
    for (let i = 1; i < served.length; i += 1) union(served[0]!, served[i]!);
  }

  const grouped = new Map<string, string[]>();
  for (const line of allLines) {
    const root = find(line);
    const bucket = grouped.get(root);
    if (bucket) bucket.push(line);
    else grouped.set(root, [line]);
  }

  // The largest group is the main network and is always component 0, so a line
  // that stands alone is component 1 rather than the odd one out.
  const ordered = [...grouped.values()].sort((a, b) => b.length - a.length || a[0]!.localeCompare(b[0]!));
  const components = ordered.map((memberLines, id) => ({ id, lines: [...memberLines].sort() }));

  const componentOfLine = new Map<string, number>();
  for (const component of components) {
    for (const line of component.lines) componentOfLine.set(line, component.id);
  }

  return {
    components,
    componentOfLine,
    isolatedLines: components.filter((c) => c.lines.length === 1).flatMap((c) => c.lines),
  };
}

let defaultService: MetroJourneyService | null = null;

export function getMetroJourneyService(): MetroJourneyService {
  if (!defaultService) defaultService = new MetroJourneyService();
  return defaultService;
}

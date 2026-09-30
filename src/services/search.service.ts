import {
  getBusDistinctStops,
  searchBusStops,
  type BusDistinctStop,
} from "../repositories/bus.repository.js";
import {
  getMetroDistinctStations,
  searchMetroStations,
  METRO_OPERATOR,
  type MetroStationAggregate,
} from "../repositories/metro.repository.js";
import { type TransportMode } from "../types/transport.js";
import { scoreSearchMatch, normalizeStopName, buildStopNodeId } from "../utils/normalize.js";
import {
  getFerryGhatOperators,
  searchFerryGhatNames,
} from "../repositories/ferry.repository.js";
import { getTramDistinctStops, searchTramStops, TRAM_OPERATOR } from "../repositories/tram.repository.js";
import type { TramStopRow } from "../models/tram.model.js";
import { requireDatabase } from "../repositories/base.repository.js";
import { isPlaceholderStop } from "../graph/graph.node.js";

/**
 * Global multi-modal search -- specification section 21.
 *
 * "Search should support partial/fuzzy station and stop names and return the
 * transport mode."
 *
 * Implementation notes:
 *  - A SQL ILIKE pass narrows the candidate set first, so this stays cheap even
 *    as the data grows.
 *  - Ranking happens in JavaScript with scoreSearchMatch, because the ranking
 *    depends on normalizeStopName() and cannot be expressed in SQL without
 *    duplicating that logic in a generated column the specification's DDL does
 *    not have.
 *  - Placeholder stop names such as "(no stop data captured)" are filtered out
 *    of results. They remain stored unchanged; they are simply not places.
 */

export interface SearchResult {
  /** The stop name exactly as stored in the source data. */
  name: string;
  mode: TransportMode;
  /**
   * Every mode that serves this place. Usually just `mode`, but a stop shared
   * by bus and metro is reported once with both, which is the signal a transfer
   * is possible there.
   */
  modes: TransportMode[];
  operator: string;
  /** How many distinct routes call at this stop. */
  routeCount: number;
  /** Relevance in [0, 1]. */
  score: number;
  /** Derived comparison key, useful for de-duplicating across clients. */
  normalizedName: string;
  /** Stable graph node id, so a client can plan straight into a journey. */
  nodeId: string;
}

export interface SearchOptions {
  q: string;
  mode?: "ALL" | TransportMode;
  limit?: number;
  /** Minimum relevance to include. */
  minScore?: number;
}

/**
 * One searchable place, before scoring. `routeCount` is the number of routes
 * serving it, which breaks ties between a well-served stop and a obscure halt.
 */
interface SearchCandidate {
  name: string;
  operator: string;
  routeCount: number;
  mode: TransportMode;
}

export class SearchService {
  /**
   * Ranks stops for a query.
   *
   * When the ILIKE pre-filter returns nothing, the whole distinct-stop list is
   * pulled and scored in memory instead. That fallback is what makes genuinely
   * fuzzy input ("esplenade" for "Esplanade") work, and it is affordable
   * because the current data set has well under a thousand distinct stops.
   */
  async search(options: SearchOptions): Promise<SearchResult[]> {
    requireDatabase();
    const { q } = options;
    const mode = options.mode ?? "ALL";
    const limit = options.limit ?? 20;
    const minScore = options.minScore ?? 0.35;

    type Candidate = SearchCandidate;

    const wantsBus = mode === "ALL" || mode === "BUS";
    const wantsMetro = mode === "ALL" || mode === "METRO";
    const wantsFerry = mode === "ALL" || mode === "FERRY";
    const wantsTram = mode === "ALL" || mode === "TRAM";

    const busCandidates: Candidate[] = [];
    const metroCandidates: Candidate[] = [];
    const ferryCandidates: Candidate[] = [];
    const tramCandidates: Candidate[] = [];

    if (wantsBus) {
      const rows = await searchBusStops(q, Math.max(limit * 4, 50));
      busCandidates.push(...rows.map((row) => this.toBusCandidate(row)));
      if (rows.length === 0) {
        busCandidates.push(
          ...(await getBusDistinctStops()).map((row) => this.toBusCandidate(row)),
        );
      }
    }

    if (wantsMetro) {
      const rows = await searchMetroStations(q, Math.max(limit * 4, 50));
      metroCandidates.push(...rows.map((row) => this.toMetroCandidate(row)));
      if (rows.length === 0) {
        metroCandidates.push(
          ...(await getMetroDistinctStations()).map((row) => this.toMetroCandidate(row)),
        );
      }
    }

    if (wantsFerry) {
      // Names come from the ferry legs rather than the `ferry_ghats` master table,
      // which is missing an endpoint the legs use (F003's "Babughat / Chandpal
      // Ghat"). A master-table-backed search would hide a ghat the graph can route
      // to, so both the pre-filter and the fallback use the leg-derived set.
      const names = await searchFerryGhatNames(q, Math.max(limit * 4, 50));
      ferryCandidates.push(...(await this.toFerryCandidates(names)));
      if (names.length === 0) {
        const all = await getFerryGhatOperators();
        ferryCandidates.push(...(await this.toFerryCandidates(all.map((row) => row.ghat_name))));
      }
    }

    if (wantsTram) {
      const rows = await searchTramStops(q, Math.max(limit * 4, 50));
      tramCandidates.push(...this.toTramCandidates(rows));
      if (rows.length === 0) {
        tramCandidates.push(
          ...(await getTramDistinctStops()).map((row) => ({
            name: row.stop_name,
            operator: TRAM_OPERATOR,
            routeCount: row.route_count,
            mode: "TRAM" as TransportMode,
          })),
        );
      }
    }

    const scored: SearchResult[] = [];
    const seen = new Set<string>();

    for (const candidate of [...busCandidates, ...metroCandidates, ...ferryCandidates, ...tramCandidates]) {
      if (isPlaceholderStop(candidate.name)) continue;
      const score = scoreSearchMatch(q, candidate.name);
      if (score === null || score < minScore) continue;

      const normalizedName = normalizeStopName(candidate.name);
      // Collapse the same place listed under more than one mode into one result,
      // but keep every mode so the client can show where to change.
      const key = `${normalizedName}`;
      if (seen.has(key)) {
        const existing = scored.find((result) => result.normalizedName === key);
        if (existing && !existing.modes.includes(candidate.mode)) {
          existing.modes.push(candidate.mode);
        }
        continue;
      }
      seen.add(key);

      scored.push({
        name: candidate.name,
        mode: candidate.mode,
        modes: [candidate.mode],
        operator: candidate.operator,
        routeCount: candidate.routeCount,
        score: Math.round(score * 1000) / 1000,
        normalizedName,
        nodeId: buildStopNodeId(candidate.mode, candidate.operator, candidate.name),
      });
    }

    return scored.sort((a, b) => b.score - a.score || b.routeCount - a.routeCount).slice(0, limit);
  }

  private toBusCandidate(row: BusDistinctStop): {
    name: string;
    operator: string;
    routeCount: number;
    mode: TransportMode;
  } {
    return { name: row.stop_name, operator: row.operator, routeCount: row.route_count, mode: "BUS" };
  }

  /**
   * A Metro "route count" is the number of lines calling at the station, so
   * Esplanade scores as 3 (Blue, Green and Purple) rather than 1.
   */
  private toMetroCandidate(row: MetroStationAggregate): {
    name: string;
    operator: string;
    routeCount: number;
    mode: TransportMode;
  } {
    return {
      name: row.station_name,
      operator: METRO_OPERATOR,
      routeCount: row.line_count,
      mode: "METRO",
    };
  }

  /**
   * A ghat is a place, but a graph node is (FERRY, operator, name), and a ghat
   * can be served by more than one operator. One candidate per operator is
   * emitted so each returned nodeId exists in the graph; the scoring loop then
   * collapses them into a single result carrying the mode list, exactly as it
   * does for a bus stop served by several companies.
   *
   * A ghat with no operational route yields no candidate, because it has no
   * node to ride from.
   */
  private async toFerryCandidates(ghatNames: string[]): Promise<SearchCandidate[]> {
    if (ghatNames.length === 0) return [];
    const index = await getFerryGhatOperators();
    const byName = new Map(index.map((row) => [row.ghat_name, row.operators]));

    const candidates: SearchCandidate[] = [];
    for (const ghatName of ghatNames) {
      const operators = byName.get(ghatName);
      if (!operators || operators.length === 0) continue;
      for (const operator of operators) {
        candidates.push({
          name: ghatName,
          operator,
          routeCount: 1,
          mode: "FERRY",
        });
      }
    }
    return candidates;
  }

  /**
   * `searchTramStops` returns one row per route and direction, so the same
   * physical stop arrives repeatedly. Deduplicating by name and counting the
   * routes that serve it makes Esplanade outrank an obscure single-route halt,
   * which is the same signal the bus and metro mappers rely on.
   */
  private toTramCandidates(rows: TramStopRow[]): SearchCandidate[] {
    const byName = new Map<string, SearchCandidate>();
    for (const row of rows) {
      if (isPlaceholderStop(row.stop_name)) continue;
      const existing = byName.get(row.stop_name);
      if (existing) {
        existing.routeCount += 1;
      } else {
        byName.set(row.stop_name, {
          name: row.stop_name,
          operator: TRAM_OPERATOR,
          routeCount: 1,
          mode: "TRAM",
        });
      }
    }
    return [...byName.values()];
  }
}

let instance: SearchService | null = null;
export function getSearchService(): SearchService {
  if (!instance) instance = new SearchService();
  return instance;
}

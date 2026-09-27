import {
  getBusDistinctStops,
  searchBusStops,
  type BusDistinctStop,
} from "../repositories/bus.repository.js";
import { getTramDistinctStops, searchTramStops, type TramDistinctStop } from "../repositories/tram.repository.js";
import { type TransportMode } from "../types/transport.js";
import { scoreSearchMatch, normalizeStopName } from "../utils/normalize.js";
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
   * by bus and tram is reported once with both, which is the signal a transfer
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

    type Candidate = { name: string; operator: string; routeCount: number; mode: TransportMode };

    const wantsBus = mode === "ALL" || mode === "BUS";
    const wantsTram = mode === "ALL" || mode === "TRAM";

    const busCandidates: Candidate[] = [];
    const tramCandidates: Candidate[] = [];

    if (wantsBus) {
      const rows = await searchBusStops(q, Math.max(limit * 4, 50));
      busCandidates.push(...rows.map((row) => this.toCandidate(row, "BUS")));
      if (rows.length === 0) {
        busCandidates.push(
          ...(await getBusDistinctStops()).map((row) => this.toCandidate(row, "BUS")),
        );
      }
    }

    if (wantsTram) {
      const rows = await searchTramStops(q, Math.max(limit * 4, 50));
      tramCandidates.push(...rows.map((row) => this.toCandidate(row, "TRAM")));
      if (rows.length === 0) {
        tramCandidates.push(
          ...(await getTramDistinctStops()).map((row) => this.toCandidate(row, "TRAM")),
        );
      }
    }

    const scored: SearchResult[] = [];
    const seen = new Set<string>();

    for (const candidate of [...busCandidates, ...tramCandidates]) {
      if (isPlaceholderStop(candidate.name)) continue;
      const score = scoreSearchMatch(q, candidate.name);
      if (score === null || score < minScore) continue;

      const normalizedName = normalizeStopName(candidate.name);
      // Collapse the same place listed under both bus and tram into one
      // result, but keep every mode so the client can show both.
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
        nodeId: `${candidate.mode.toLowerCase()}:${candidate.operator.toLowerCase()}:${normalizedName.replace(/\s+/g, "-")}`,
      });
    }

    return scored.sort((a, b) => b.score - a.score || b.routeCount - a.routeCount).slice(0, limit);
  }

  private toCandidate(
    row: BusDistinctStop | TramDistinctStop,
    mode: TransportMode,
  ): { name: string; operator: string; routeCount: number; mode: TransportMode } {
    return { name: row.stop_name, operator: row.operator, routeCount: row.route_count, mode };
  }
}

let instance: SearchService | null = null;
export function getSearchService(): SearchService {
  if (!instance) instance = new SearchService();
  return instance;
}

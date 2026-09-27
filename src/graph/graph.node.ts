import type { GraphNode, TransportMode } from "../types/transport.js";
import { buildStopNodeId, normalizeStopName } from "../utils/normalize.js";

/**
 * Graph node construction and lookup.
 *
 * Node identity rule: a node is one (mode, operator, normalised name) triple.
 * Two bus routes that both call at "Esplanade" therefore share a single node,
 * which is what makes an intra-mode interchange cost nothing. Two nodes are only
 * linked explicitly by TransferService.
 */

/**
 * Source rows containing one of these phrases are placeholders from the data
 * collection process, not real places -- for example the literal stop name
 * "(no stop data captured)" appears in the bus source file.
 *
 * They are still stored in the database unchanged (the specification requires
 * preserving source data) but they are excluded from the graph, from search and
 * from transfer detection, because treating them as a shared location would
 * invent an interchange that does not exist.
 */
const PLACEHOLDER_PATTERN =
  /\(\s*no\s+stop\s+data\s+captured\s*\)|^\s*no\s+stop\s+data\s+captured\s*$|^\s*unknown\s*$/i;

export function isPlaceholderStop(stopName: string | null | undefined): boolean {
  if (!stopName) return true;
  return PLACEHOLDER_PATTERN.test(stopName.trim());
}

export interface NodeCandidate {
  name: string;
  mode: TransportMode;
  operator?: string;
  latitude?: number;
  longitude?: number;
}

export function createStopNode(candidate: NodeCandidate): GraphNode {
  const node: GraphNode = {
    id: buildStopNodeId(candidate.mode, candidate.operator, candidate.name),
    name: candidate.name,
    mode: candidate.mode,
  };
  if (candidate.operator) node.operator = candidate.operator;
  if (typeof candidate.latitude === "number") node.latitude = candidate.latitude;
  if (typeof candidate.longitude === "number") node.longitude = candidate.longitude;
  return node;
}

export function hasCoordinates(node: GraphNode): boolean {
  return typeof node.latitude === "number" && typeof node.longitude === "number";
}

/**
 * Index from normalised stop name to every node carrying that name. This is
 * the only structure transfer detection needs, and it is why a linear scan over
 * all node pairs is never required.
 */
export class StopNameIndex {
  private readonly index = new Map<string, GraphNode[]>();

  add(node: GraphNode): void {
    const key = normalizeStopName(node.name);
    if (key.length === 0) return;
    const bucket = this.index.get(key);
    if (bucket) {
      bucket.push(node);
    } else {
      this.index.set(key, [node]);
    }
  }

  /** Nodes whose normalised name is exactly `normalizedName`. */
  get(normalizedName: string): GraphNode[] {
    return this.index.get(normalizedName) ?? [];
  }

  /**
   * Candidate nodes for a fuzzy transfer lookup: exact name matches plus, when
   * `includeSimilar` is set, any node sharing at least one significant token.
   * The caller still applies the similarity threshold, so this is a cheap
   * pre-filter rather than the decision itself.
   */
  getCandidates(normalizedName: string, includeSimilar: boolean): GraphNode[] {
    const exact = this.index.get(normalizedName) ?? [];
    if (!includeSimilar) return exact;

    const seen = new Set<string>(exact.map((node) => node.id));
    const candidates = [...exact];
    const tokens = new Set(normalizedName.split(" ").filter((token) => token.length >= 4));

    if (tokens.size === 0) return candidates;

    for (const [key, nodes] of this.index) {
      if (seen.has(key)) continue;
      const sharesToken = key.split(" ").some((token) => tokens.has(token));
      if (sharesToken) {
        for (const node of nodes) {
          if (!seen.has(node.id)) {
            seen.add(node.id);
            candidates.push(node);
          }
        }
      }
    }

    return candidates;
  }

  get size(): number {
    return this.index.size;
  }
}

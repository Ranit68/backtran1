import type { GraphNode } from "../types/transport.js";
import { nameSimilarity, normalizeStopName } from "../utils/normalize.js";
import { hasCoordinates, StopNameIndex } from "../graph/graph.node.js";
import { haversineDistanceMeters } from "../utils/geo.js";
import { env } from "../config/env.js";

/**
 * TransferService -- specification section 12.
 *
 * "If coordinates are available, calculate geographical distance. Use
 * configurable distance, name similarity and transport mode when determining
 * transfer candidates. Do not connect every similarly named stop
 * automatically."
 *
 * The current data set (bus route stops + metro stations) contains NO coordinates, so
 * distance-based detection cannot run yet and the service falls back to name
 * matching. That fallback is deliberately strict: an exact normalised-name
 * match, or a similarity at or above the configured threshold across DIFFERENT
 * modes or operators. It never links two nodes that share a mode and operator,
 * because those are already the same node.
 *
 * Adding Metro (which does have coordinates) will switch the primary rule to
 * the 300-metre proximity test with no change here.
 */

export const MAX_TRANSFER_DISTANCE_METERS = 300;

/** Average adult walking speed, used only to convert a real distance to time. */
const WALKING_SPEED_METERS_PER_MINUTE = 4.5 * 1000 / 60;

export interface TransferCandidate {
  from: GraphNode;
  to: GraphNode;
  reason: "COORDINATE_PROXIMITY" | "EXACT_NAME_MATCH" | "HIGH_SIMILARITY";
  distanceMeters: number | null;
  nameSimilarity: number;
  transferTimeMinutes: number;
}

export interface TransferDetectionResult {
  candidates: TransferCandidate[];
  stats: {
    nodesConsidered: number;
    nameIndexKeys: number;
    distanceChecks: number;
    rejectedByDistance: number;
    rejectedBySimilarity: number;
    rejectedSameSystem: number;
  };
}

export interface TransferDetectionOptions {
  maxDistanceMeters?: number;
  similarityThreshold?: number;
  defaultTransferMinutes?: number;
}

export class TransferService {
  private readonly maxDistanceMeters: number;
  private readonly similarityThreshold: number;
  private readonly defaultTransferMinutes: number;

  constructor(options: TransferDetectionOptions = {}) {
    this.maxDistanceMeters = options.maxDistanceMeters ?? env.MAX_TRANSFER_DISTANCE_METERS;
    this.similarityThreshold =
      options.similarityThreshold ?? env.TRANSFER_NAME_SIMILARITY_THRESHOLD;
    this.defaultTransferMinutes = options.defaultTransferMinutes ?? env.DEFAULT_TRANSFER_MINUTES;
  }

  get config(): { maxDistanceMeters: number; similarityThreshold: number; defaultTransferMinutes: number } {
    return {
      maxDistanceMeters: this.maxDistanceMeters,
      similarityThreshold: this.similarityThreshold,
      defaultTransferMinutes: this.defaultTransferMinutes,
    };
  }

  /**
   * Finds every transfer pair among the given nodes.
   *
   * Runs once per graph build, not per request (spec section 25: "Do not
   * rebuild the complete graph for every request").
   */
  detect(nodes: GraphNode[]): TransferDetectionResult {
    const index = new StopNameIndex();
    for (const node of nodes) index.add(node);

    const candidates: TransferCandidate[] = [];
    const stats = {
      nodesConsidered: nodes.length,
      nameIndexKeys: index.size,
      distanceChecks: 0,
      rejectedByDistance: 0,
      rejectedBySimilarity: 0,
      rejectedSameSystem: 0,
    };

    const seenPairs = new Set<string>();

    for (const node of nodes) {
      const normalizedName = normalizeStopName(node.name);
      if (normalizedName.length === 0) continue;

      // Exact-name neighbours plus a token-overlap pre-filter. The similarity
      // threshold below still has the final say on every pair.
      const potential = index.getCandidates(normalizedName, true);

      for (const other of potential) {
        if (other.id <= node.id) continue; // process each unordered pair once

        const pairKey = `${node.id}|${other.id}`;
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);

        // Two stops of the same mode operated by the same company are either
        // already one node or two spellings of the same place. Linking them
        // would be the "connect every similarly named stop" behaviour the
        // specification rules out.
        if (node.mode === other.mode && (node.operator ?? "") === (other.operator ?? "")) {
          stats.rejectedSameSystem += 1;
          continue;
        }

        const nodeHasCoords = hasCoordinates(node);
        const otherHasCoords = hasCoordinates(other);
        const bothHaveCoords = nodeHasCoords && otherHasCoords;

        let distanceMeters: number | null = null;
        let reason: TransferCandidate["reason"];
        let similarity: number;

        if (bothHaveCoords) {
          // Coordinates are authoritative when both stops have them.
          stats.distanceChecks += 1;
          distanceMeters = haversineDistanceMeters(
            { latitude: node.latitude!, longitude: node.longitude! },
            { latitude: other.latitude!, longitude: other.longitude! },
          );
          if (distanceMeters > this.maxDistanceMeters) {
            stats.rejectedByDistance += 1;
            continue;
          }
          // Names still matter: two stops 40 m apart with unrelated names are
          // different places, not an interchange.
          similarity = nameSimilarity(node.name, other.name);
          if (similarity < 0.5) {
            stats.rejectedBySimilarity += 1;
            continue;
          }
          reason = "COORDINATE_PROXIMITY";
        } else {
          // No coordinates available: fall back to strict name matching.
          if (normalizedName === normalizeStopName(other.name)) {
            similarity = 1;
            reason = "EXACT_NAME_MATCH";
          } else {
            similarity = nameSimilarity(node.name, other.name);
            if (similarity < this.similarityThreshold) {
              stats.rejectedBySimilarity += 1;
              continue;
            }
            reason = "HIGH_SIMILARITY";
          }
        }

        // A real distance gives a real walk time. Without one, the configured
        // static estimate is used and no distance is reported at all, so the
        // API never presents a fabricated figure.
        const transferTimeMinutes =
          distanceMeters !== null
            ? Math.max(1, Math.ceil(distanceMeters / WALKING_SPEED_METERS_PER_MINUTE))
            : this.defaultTransferMinutes;

        candidates.push({
          from: node,
          to: other,
          reason,
          distanceMeters,
          nameSimilarity: Math.round(similarity * 1000) / 1000,
          transferTimeMinutes,
        });
      }
    }

    return { candidates, stats };
  }
}

import { env } from "../config/env.js";
import { AppError, ErrorCode } from "../utils/errors.js";
import { buildTransportGraph, type GraphStats, type TransportGraph } from "../graph/transport.graph.js";

/**
 * Graph cache -- specification section 25.
 *
 * "Do not rebuild the complete graph for every request. Prefer loading
 * transport data, building the graph and caching it. Provide a graph refresh
 * mechanism when transport data changes."
 *
 * The cache is in-process, which is the right shape for a single container or
 * a Vercel function instance. On serverless each cold start pays one build
 * (~1750 rows, single-digit milliseconds) and then serves from memory.
 *
 * A minimum interval between rebuilds stops a burst of traffic after a data
 * import from stampeding the database with concurrent graph builds.
 */

let cached: TransportGraph | null = null;
let inFlight: Promise<TransportGraph> | null = null;
let lastBuiltAt = 0;
let lastBuildError: string | null = null;

function isStale(graph: TransportGraph): boolean {
  return Date.now() - new Date(graph.data.stats.builtAt).getTime() > env.GRAPH_CACHE_TTL_SECONDS * 1000;
}

/** Returns the cached graph, building it if absent, stale, or previously failed. */
export async function getGraph(): Promise<TransportGraph> {
  if (cached && !isStale(cached)) return cached;

  // Collapse concurrent builds into one query storm instead of N.
  if (inFlight) return inFlight;

  inFlight = buildTransportGraph()
    .then((graph) => {
      cached = graph;
      lastBuiltAt = Date.now();
      lastBuildError = null;
      return graph;
    })
    .catch((error: unknown) => {
      lastBuildError = error instanceof Error ? error.message : String(error);
      throw error;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/**
 * Forces a rebuild. Backs POST /api/admin/graph/refresh.
 *
 * Returns the fresh graph's statistics. Throws GRAPH_UNAVAILABLE if a rebuild
 * was attempted too soon after the last one, so an admin cannot accidentally
 * hammer the database.
 */
export async function refreshGraph(options: { force?: boolean } = {}): Promise<GraphStats> {
  const elapsed = Date.now() - lastBuiltAt;
  if (!options.force && cached && elapsed < env.GRAPH_REBUILD_MIN_INTERVAL_SECONDS * 1000) {
    throw new AppError(
      ErrorCode.GRAPH_UNAVAILABLE,
      `The transport graph was rebuilt ${Math.round(elapsed / 1000)}s ago. ` +
        `Wait ${env.GRAPH_REBUILD_MIN_INTERVAL_SECONDS}s or pass ?force=true.`,
      { retryAfterSeconds: env.GRAPH_REBUILD_MIN_INTERVAL_SECONDS - Math.floor(elapsed / 1000) },
    );
  }

  const graph = await buildTransportGraph();
  cached = graph;
  lastBuiltAt = Date.now();
  lastBuildError = null;
  return graph.data.stats;
}

export function getCachedGraph(): TransportGraph | null {
  return cached;
}

/** Non-throwing status for GET /api/health. */
export function getGraphStatus(): {
  built: boolean;
  stale: boolean | null;
  lastBuiltAt: string | null;
  lastBuildError: string | null;
  nodeCount: number | null;
} {
  return {
    built: cached !== null,
    stale: cached ? isStale(cached) : null,
    lastBuiltAt: cached ? cached.data.stats.builtAt : null,
    lastBuildError,
    nodeCount: cached ? cached.nodeCount : null,
  };
}

/** Drops the cache without rebuilding. Used by tests. */
export function clearGraphCache(): void {
  cached = null;
  inFlight = null;
  lastBuiltAt = 0;
  lastBuildError = null;
}

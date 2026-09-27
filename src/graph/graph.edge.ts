import type { GraphEdge, GraphEdgeMode } from "../types/transport.js";

/**
 * Graph edge construction and cost model.
 *
 * Every edge carries its own cost in minutes so the pathfinder never has to
 * know where the edge came from. Edges also record how their time was derived,
 * which the journey planner surfaces to clients as `timingConfidence`.
 */

export interface RideEdgeInput {
  fromNodeId: string;
  toNodeId: string;
  mode: Exclude<GraphEdgeMode, "TRANSFER" | "WALK">;
  routeId: string;
  routeNo: string;
  operator: string;
  estimatedTimeMinutes: number;
  /**
   * Position of the boarding stop within the route (0-based) and the number of
   * hops the route has in total. The journey planner uses these to work out
   * which scheduled trip covers a given pair of stops.
   */
  fromHop: number;
  toHop: number;
  totalHops: number;
}

export interface RideEdge extends GraphEdge {
  /** Position of the boarding stop within the route (0-based). */
  fromHop: number;
  /** Position of the alighting stop within the route (0-based). */
  toHop: number;
  /** Total hops the route has. */
  totalHops: number;
}

export function createRideEdges(input: RideEdgeInput): RideEdge[] {
  const forward: RideEdge = {
    fromNodeId: input.fromNodeId,
    toNodeId: input.toNodeId,
    mode: input.mode,
    routeId: input.routeId,
    routeNo: input.routeNo,
    operator: input.operator,
    estimatedTimeMinutes: input.estimatedTimeMinutes,
    fromHop: input.fromHop,
    toHop: input.toHop,
    totalHops: input.totalHops,
  };
  // The route-stop source gives one ordered stop list per route with no
  // direction column, so a vehicle is modelled as running both ways along its
  // own stop sequence. This is a modelling assumption about direction, not
  // invented data; every stop name and order is exactly as supplied.
  const backward: RideEdge = {
    ...forward,
    fromNodeId: input.toNodeId,
    toNodeId: input.fromNodeId,
    // A backward hop is traversed in the other direction, so the two hop
    // indices swap. The journey planner relies on this to position a segment
    // within a route.
    fromHop: input.toHop,
    toHop: input.fromHop,
  };
  return [forward, backward];
}

export interface TransferEdgeInput {
  fromNodeId: string;
  toNodeId: string;
  transferTimeMinutes: number;
  distanceMeters?: number;
  /** Why this pair was linked, surfaced in the graph diagnostics. */
  reason: "COORDINATE_PROXIMITY" | "EXACT_NAME_MATCH" | "HIGH_SIMILARITY";
  nameSimilarity: number;
}

export function createTransferEdge(input: TransferEdgeInput): GraphEdge {
  const edge: GraphEdge = {
    fromNodeId: input.fromNodeId,
    toNodeId: input.toNodeId,
    // A change between two vehicles is a WALK plus a wait. TRANSFER marks an
    // interchange between different systems; WALK marks the walking part.
    mode: "TRANSFER",
    transferTimeMinutes: input.transferTimeMinutes,
  };
  if (input.distanceMeters !== undefined) edge.distanceMeters = input.distanceMeters;
  if (input.reason !== undefined) {
    (edge as GraphEdge & { transferReason?: string }).transferReason = input.reason;
  }
  (edge as GraphEdge & { nameSimilarity?: number }).nameSimilarity = input.nameSimilarity;
  return edge;
}

export function isRideEdge(edge: GraphEdge): edge is RideEdge {
  return edge.mode !== "TRANSFER" && edge.mode !== "WALK";
}

export function isTransferEdge(edge: GraphEdge): boolean {
  return edge.mode === "TRANSFER" || edge.mode === "WALK";
}

/** Travel time of an edge in minutes, used directly as the pathfinding cost. */
export function edgeTimeMinutes(edge: GraphEdge): number {
  if (isTransferEdge(edge)) {
    return edge.transferTimeMinutes ?? edge.estimatedTimeMinutes ?? 0;
  }
  return edge.estimatedTimeMinutes ?? 0;
}

/** The ride this edge belongs to, or null for a transfer edge. */
export function edgeRouteNo(edge: GraphEdge): string | undefined {
  return isRideEdge(edge) ? edge.routeNo : undefined;
}

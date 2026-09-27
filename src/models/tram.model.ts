import type { TransportMode } from "../types/transport.js";

/** Row shape of `tram_route_stops` as returned by the pg driver. */
export interface TramRouteStopRow {
  id: string;
  operator: string;
  vehicle_type: string;
  route_no: string;
  depot: string | null;
  /** NULL when the source CSV had no sequence. Never coerced to 0. */
  stop_sequence_no: number | null;
  stop_name: string;
  created_at: Date;
}

// ---------------------------------------------------------------------------
// API view models
// ---------------------------------------------------------------------------

export interface TramRouteStopView {
  id: string;
  stopName: string;
  /** null when the source had no sequence for this stop. */
  stopSequenceNo: number | null;
  depot: string | null;
  normalizedName: string;
}

export interface TramRouteSummary {
  routeId: string;
  routeNo: string;
  mode: "TRAM";
  operator: string;
  vehicleType: string;
  depot: string | null;
  stopCount: number;
  /**
   * True when every stop in this route has a sequence number. Routes where
   * the source omitted sequences are flagged so clients know the stop order
   * is source order rather than a verified timetable order.
   */
  fullySequenced: boolean;
  firstStop: string | null;
  lastStop: string | null;
  hasTimetable: false;
}

export interface TramRouteDetail extends TramRouteSummary {
  stops: TramRouteStopView[];
}

/** Placeholder so the ferry surface can be typed before any ferry data exists. */
export type FerryModeNote = {
  mode: TransportMode;
  implemented: false;
  reason: string;
};

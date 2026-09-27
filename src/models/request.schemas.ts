import { z } from "zod";
import { TRANSPORT_MODES } from "../types/transport.js";

/**
 * Request validation. Every endpoint validates its input here so the
 * controllers stay thin and the rules are testable in one place
 * (spec section 25: "Validate API requests").
 */

const trimmedQuery = z
  .string()
  .trim()
  .min(1, "q must not be empty")
  .max(120, "q must be at most 120 characters");

/** Turns a ZodError into a flat, client-friendly details array. */
export function formatZodError(error: z.ZodError): { field: string; message: string }[] {
  return error.issues.map((issue) => ({
    field: issue.path.join(".") || "(root)",
    message: issue.message,
  }));
}

// ---------------------------------------------------------------------------
// GET /api/search
// ---------------------------------------------------------------------------

export const searchQuerySchema = z.object({
  q: trimmedQuery,
  mode: z.enum(["ALL", ...TRANSPORT_MODES]).default("ALL"),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type SearchQuery = z.infer<typeof searchQuerySchema>;

// ---------------------------------------------------------------------------
// Route / station listing
// ---------------------------------------------------------------------------

export const routeListQuerySchema = z.object({
  operator: z.string().trim().min(1).max(50).optional(),
  q: z.string().trim().max(120).optional(),
  sort: z.enum(["route_no", "stop_count", "avg_trip_minutes"]).default("route_no"),
  order: z.enum(["asc", "desc"]).default("asc"),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const tramRouteListQuerySchema = z.object({
  operator: z.string().trim().min(1).max(50).optional(),
  q: z.string().trim().max(120).optional(),
  sort: z.enum(["route_no", "stop_count"]).default("route_no"),
  order: z.enum(["asc", "desc"]).default("asc"),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const modeQuerySchema = z.object({
  mode: z.enum(["ALL", ...TRANSPORT_MODES]).default("ALL"),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** Route numbers contain letters, hyphens, slashes and spaces, so stay permissive. */
export const routeNoParamSchema = z
  .string()
  .trim()
  .min(1, "route number is required")
  .max(50, "route number must be at most 50 characters");

// ---------------------------------------------------------------------------
// GET /api/bus/routes/:routeNo/timetable
// ---------------------------------------------------------------------------

export const timetableQuerySchema = z.object({
  operator: z.string().trim().min(1).max(50).optional(),
  directionId: z.coerce.number().int().min(0).max(9).optional(),
  /** Only trips departing at or after this HH:MM. */
  from: z
    .string()
    .trim()
    .regex(/^\d{1,2}:[0-5]\d$/, "from must be HH:MM")
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export type TimetableQuery = z.infer<typeof timetableQuerySchema>;

// ---------------------------------------------------------------------------
// POST /api/journey
// ---------------------------------------------------------------------------

export const journeyRequestSchema = z
  .object({
    source: z.string().trim().min(1, "source is required").max(120),
    destination: z.string().trim().min(1, "destination is required").max(120),
    mode: z.enum(["ALL", ...TRANSPORT_MODES]).default("ALL"),
    strategy: z.enum(["MIN_TIME", "MIN_INTERCHANGE"]).default("MIN_TIME"),
    /** ISO-8601 date-time, or "HH:MM" for a time-only request. */
    departureTime: z.string().trim().min(1).max(40).optional(),
    timetableAware: z
      .union([z.boolean(), z.string()])
      .transform((value) => (typeof value === "boolean" ? value : ["1", "true", "yes"].includes(value.toLowerCase())))
      .default(true),
  })
  .refine((value) => value.source.toLowerCase() !== value.destination.toLowerCase(), {
    message: "source and destination must be different",
    path: ["destination"],
  });

export type JourneyBody = z.infer<typeof journeyRequestSchema>;

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export const refreshQuerySchema = z.object({
  force: z
    .union([z.boolean(), z.string()])
    .transform((value) => (typeof value === "boolean" ? value : ["1", "true", "yes"].includes(value.toLowerCase())))
    .default(false),
});

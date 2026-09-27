/**
 * Application error taxonomy -- specification section 23.
 *
 * Every failure that reaches a client is an AppError so the centralised
 * handler can emit `{ success: false, error: { code, message, details? } }`.
 * Anything else that escapes a handler is reported as INTERNAL_ERROR with the
 * real message hidden from the client in production.
 */

export const ErrorCode = {
  // 400
  VALIDATION_ERROR: "VALIDATION_ERROR",
  INVALID_QUERY: "INVALID_QUERY",
  INVALID_JSON: "INVALID_JSON",

  // 404
  NOT_FOUND: "NOT_FOUND",
  ROUTE_NOT_FOUND: "ROUTE_NOT_FOUND",
  STATION_NOT_FOUND: "STATION_NOT_FOUND",
  STOP_NOT_FOUND: "STOP_NOT_FOUND",
  TRIP_NOT_FOUND: "TRIP_NOT_FOUND",

  // 409 / 422
  NO_ROUTE_FOUND: "NO_ROUTE_FOUND",

  // 429
  RATE_LIMITED: "RATE_LIMITED",

  // 501 -- a mode the specification reserves but that has no data yet
  METRO_NOT_CONFIGURED: "METRO_NOT_CONFIGURED",
  FERRY_NOT_CONFIGURED: "FERRY_NOT_CONFIGURED",

  // 503
  DATABASE_NOT_CONFIGURED: "DATABASE_NOT_CONFIGURED",
  DATABASE_UNAVAILABLE: "DATABASE_UNAVAILABLE",
  ADMIN_AUTH_REQUIRED: "ADMIN_AUTH_REQUIRED",
  GRAPH_UNAVAILABLE: "GRAPH_UNAVAILABLE",

  // 500
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

const DEFAULT_STATUS: Record<ErrorCodeValue, number> = {
  VALIDATION_ERROR: 400,
  INVALID_QUERY: 400,
  INVALID_JSON: 400,
  NOT_FOUND: 404,
  ROUTE_NOT_FOUND: 404,
  STATION_NOT_FOUND: 404,
  STOP_NOT_FOUND: 404,
  TRIP_NOT_FOUND: 404,
  NO_ROUTE_FOUND: 422,
  RATE_LIMITED: 429,
  METRO_NOT_CONFIGURED: 501,
  FERRY_NOT_CONFIGURED: 501,
  DATABASE_NOT_CONFIGURED: 503,
  DATABASE_UNAVAILABLE: 503,
  ADMIN_AUTH_REQUIRED: 503,
  GRAPH_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

export class AppError extends Error {
  readonly code: ErrorCodeValue;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(code: ErrorCodeValue, message: string, details?: unknown, statusCode?: number) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = statusCode ?? DEFAULT_STATUS[code];
    if (details !== undefined) this.details = details;
  }
}

export const notFound = (message: string, details?: unknown): AppError =>
  new AppError(ErrorCode.NOT_FOUND, message, details);

export const validationError = (message: string, details?: unknown): AppError =>
  new AppError(ErrorCode.VALIDATION_ERROR, message, details);

/**
 * Thrown by the repositories when no database is configured. Declared here
 * rather than in database.ts to keep the dependency direction one-way:
 * database.ts must not import from the error layer.
 */
export const databaseNotConfigured = (): AppError =>
  new AppError(
    ErrorCode.DATABASE_NOT_CONFIGURED,
    "This backend is running without DATABASE_URL. Set it in .env and restart to enable live transport data.",
  );

export const databaseUnavailable = (detail: string): AppError =>
  new AppError(ErrorCode.DATABASE_UNAVAILABLE, "The transport database is currently unreachable.", { detail });

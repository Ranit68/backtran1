import { query } from "../config/database.js";
import { env } from "../config/env.js";
import { AppError, ErrorCode, databaseNotConfigured, databaseUnavailable } from "../utils/errors.js";

/**
 * Guards every database call. Repositories call this first so that a missing
 * DATABASE_URL surfaces as a clean 503 in the standard error envelope instead
 * of a raw driver exception.
 */
export function requireDatabase(): void {
  if (!env.hasDatabase) {
    throw databaseNotConfigured();
  }
}

/** Wraps a query so driver-level failures become DATABASE_UNAVAILABLE. */
export async function withDatabaseErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AppError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (message === "DATABASE_NOT_CONFIGURED") throw databaseNotConfigured();
    throw databaseUnavailable(message);
  }
}

/** Escapes the LIKE/ILIKE metacharacters in a user-supplied search term. */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export interface PageOptions {
  limit: number;
  offset: number;
}

/** Clamps paging input so a client cannot ask for the whole table by accident. */
export function normalizePaging(limit: unknown, offset: unknown, maxLimit = 500): PageOptions {
  const parsedLimit = Number(limit);
  const parsedOffset = Number(offset);
  return {
    limit:
      Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.min(Math.floor(parsedLimit), maxLimit)
        : 50,
    offset: Number.isFinite(parsedOffset) && parsedOffset > 0 ? Math.floor(parsedOffset) : 0,
  };
}

export { ErrorCode };

/**
 * Page size for `loadAllRows`. The specification's concern is the 1000-row
 * Supabase REST response cap; this project reads through the pg driver, which
 * has no such cap, so the chunking is defensive rather than corrective. It
 * keeps peak memory bounded as the ferry/tram tables grow.
 */
export const LOADER_PAGE_SIZE = 1000;

/**
 * Loads a whole table in ordered pages, so a mode's graph build never depends
 * on a single response containing every row.
 *
 * `orderBy` must name a column that is unique or the paging loop can repeat or
 * skip rows, so callers pass a primary key. Callers that need a different sort
 * can re-order the returned array afterwards, which is cheaper than an OFFSET
 * scan.
 */
export async function loadAllRows<T>(
  table: string,
  orderBy: string,
  rowMapper?: (row: Record<string, unknown>) => T,
): Promise<T[]> {
  requireDatabase();
  const rows: T[] = [];
  // OFFSET paging is safe here because these tables are small, read once at
  // startup, and never written to concurrently by the API.
  for (let offset = 0; ; offset += LOADER_PAGE_SIZE) {
    const page = await withDatabaseErrors(() =>
      query<Record<string, unknown>>(
        `SELECT * FROM ${table} ORDER BY ${orderBy} ASC LIMIT $1 OFFSET $2`,
        [LOADER_PAGE_SIZE, offset],
      ),
    );
    for (const row of page) {
      rows.push(rowMapper ? rowMapper(row) : (row as unknown as T));
    }
    if (page.length < LOADER_PAGE_SIZE) break;
  }
  return rows;
}


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

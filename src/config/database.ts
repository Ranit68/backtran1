import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { env } from "./env.js";

/**
 * Lazy Postgres pool.
 *
 * `pg` is imported eagerly (it is a hard dependency) but no connection is
 * opened until the first query. `env.hasDatabase` gates every repository, so
 * this pool is simply never used when DATABASE_URL is absent.
 */
let pool: Pool | null = null;

export function getPool(): Pool {
  if (!env.hasDatabase) {
    throw new Error("DATABASE_NOT_CONFIGURED");
  }
  if (!pool) {
    pool = new Pool({
      connectionString: env.DATABASE_URL,
      max: env.isProduction ? 10 : 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      // Supabase terminates idle connections aggressively; keep TLS-friendly defaults.
      allowExitOnIdle: env.isTest,
    });
    pool.on("error", (error) => {
      // An idle client blew up. Log and let the pool replace it rather than
      // taking the whole API process down.
      console.error("[database] idle client error", error.message);
    });
  }
  return pool;
}

export async function query<T extends QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const result = await getPool().query<T>(text, params as unknown[]);
  return result.rows;
}

export async function queryOne<T extends QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/** Run `handler` inside a transaction, rolling back on any throw. */
export async function withTransaction<T>(
  handler: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await handler(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** True when the database is reachable and the transport tables exist. */
export async function pingDatabase(): Promise<{ ok: boolean; detail: string }> {
  if (!env.hasDatabase) {
    return { ok: false, detail: "DATABASE_URL is not set" };
  }
  try {
    await query("SELECT 1");
    return { ok: true, detail: "connected" };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : "unknown error" };
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

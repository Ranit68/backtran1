import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPool, withTransaction } from "../config/database.js";
import { env } from "../config/env.js";
import { isDirectRun } from "../utils/direct-run.js";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

/**
 * Tables a migration is about to create, by name.
 *
 * Used to detect a name collision before any DDL runs. A pre-existing table
 * with a different shape is the failure mode worth catching early: without
 * this, `CREATE TABLE IF NOT EXISTS` silently skips creation and the migration
 * dies later on an index that references a column the old table never had,
 * which reads like a typo rather than a schema conflict.
 */
function createdTableNames(sql: string): string[] {
  const names: string[] = [];
  const pattern = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi;
  let match: RegExpExecArray | null = pattern.exec(sql);
  while (match !== null) {
    const name = match[1];
    if (name !== undefined) names.push(name.toLowerCase());
    match = pattern.exec(sql);
  }
  return names;
}

async function findCollisions(
  files: string[],
): Promise<{ filename: string; table: string; columns: string[] }[]> {
  const collisions: { filename: string; table: string; columns: string[] }[] = [];
  const pool = getPool();

  for (const filename of files) {
    const sql = await readFile(join(MIGRATIONS_DIR, filename), "utf8");
    for (const table of createdTableNames(sql)) {
      const existing = await pool.query<{ column_name: string }>(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1
          ORDER BY ordinal_position`,
        [table],
      );
      if (existing.rows.length > 0) {
        collisions.push({
          filename,
          table,
          columns: existing.rows.map((r) => r.column_name),
        });
      }
    }
  }
  return collisions;
}

/**
 * Applies every .sql file in src/db/migrations in filename order, inside one
 * transaction each, recording what ran in schema_migrations.
 *
 * Deliberately hand-rolled rather than pulling in a migration framework: the
 * project must stay deployable to Vercel and to a plain Postgres box with no
 * extra runtime surprises.
 */
export async function runMigrations(): Promise<{ applied: string[]; skipped: string[] }> {
  const applied: string[] = [];
  const skipped: string[] = [];

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((name) => name.endsWith(".sql"))
    .sort();

  const pool = getPool();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const { rows } = await pool.query<{ filename: string }>(
    "SELECT filename FROM schema_migrations",
  );
  const alreadyApplied = new Set(rows.map((row) => row.filename));
  const pending = files.filter((filename) => !alreadyApplied.has(filename));

  const collisions = await findCollisions(pending);
  if (collisions.length > 0) {
    const detail = collisions
      .map(
        (c) =>
          `  - ${c.filename} wants to create "${c.table}", which already exists with columns: ${c.columns.join(", ")}`,
      )
      .join("\n");
    throw new Error(
      `Refusing to run migrations: ${collisions.length} table name collision(s) with an existing schema.\n${detail}\n\n` +
        `This database already has tables from earlier work. Either point the app at an empty ` +
        `database, or remove/rename the conflicting tables, then re-run. Nothing was changed.`,
    );
  }

  for (const filename of pending) {
    const sql = await readFile(join(MIGRATIONS_DIR, filename), "utf8");
    try {
      await withTransaction(async (client) => {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [filename]);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Migration ${filename} failed: ${message}`);
    }
    applied.push(filename);
  }

  for (const filename of files) {
    if (alreadyApplied.has(filename)) skipped.push(filename);
  }

  return { applied, skipped };
}

if (isDirectRun(import.meta.url)) {
  if (!env.hasDatabase) {
    console.error("DATABASE_URL is not set. Add it to .env before running migrations.");
    process.exit(1);
  }
  runMigrations()
    .then(({ applied, skipped }) => {
      console.log(`Migrations applied: ${applied.length}, skipped: ${skipped.length}`);
      for (const name of applied) console.log(`  + ${name}`);
      for (const name of skipped) console.log(`  = ${name} (already applied)`);
      process.exit(0);
    })
    .catch((error: unknown) => {
      console.error("Migration failed:", error instanceof Error ? error.message : error);
      process.exit(1);
    });
}

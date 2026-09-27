import { recordImportRun, summarize, type ImportResult } from "./import-csv.js";
import { importBusRoutes } from "./import-csv.js";
import { importBusTimetable } from "./import-csv.js";
import { closePool } from "../config/database.js";
import { env } from "../config/env.js";
import { isDirectRun } from "../utils/direct-run.js";

/**
 * Runs the two bus imports the specification defines, in filename order so the
 * console log matches the source data. They are independent tables, so the
 * order is presentational rather than a dependency: the timetable import
 * recomputes route_trip_stats from bus_timetables alone and does not read bus
 * route stops.
 *
 * There is deliberately no Metro import step. The Metro tables are maintained
 * outside this service and are read-only here, and the retired Tram importer is
 * gone with the rest of the Tram surface.
 */
export async function importAll(): Promise<ImportResult[]> {
  if (!env.hasDatabase) {
    throw new Error("DATABASE_URL is not set. Add it to .env before importing.");
  }

  const results: ImportResult[] = [];

  const steps: [string, () => Promise<ImportResult>][] = [
    ["wbtc_bus_routes.csv", () => importBusRoutes()],
    ["wbtc_bus_timetable_final.csv", () => importBusTimetable()],
  ];

  for (const [label, run] of steps) {
    console.log(`\n--- importing ${label} ---`);
    const result = await run();
    console.log(summarize(result));
    await recordImportRun(result);
    results.push(result);
  }

  return results;
}

if (isDirectRun(import.meta.url)) {
  importAll()
    .then(async (results) => {
      const totalRead = results.reduce((sum, r) => sum + r.rowsRead, 0);
      const totalInserted = results.reduce((sum, r) => sum + r.rowsInserted, 0);
      const totalRejected = results.reduce((sum, r) => sum + r.rowsRejected, 0);
      console.log(
        `\nDone. ${totalInserted}/${totalRead} rows imported, ${totalRejected} rejected across ${results.length} file(s).`,
      );
      await closePool();
      process.exit(0);
    })
    .catch(async (error: unknown) => {
      console.error("Import failed:", error instanceof Error ? error.message : error);
      await closePool().catch(() => undefined);
      process.exit(1);
    });
}

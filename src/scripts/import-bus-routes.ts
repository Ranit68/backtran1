import { closePool } from "../config/database.js";
import { isDirectRun } from "../utils/direct-run.js";
import { importBusRoutes, recordImportRun, summarize } from "./import-csv.js";

if (isDirectRun(import.meta.url)) {
  importBusRoutes()
    .then(async (result) => {
      console.log(summarize(result));
      await recordImportRun(result);
      await closePool();
      process.exit(0);
    })
    .catch(async (error: unknown) => {
      console.error("Import failed:", error instanceof Error ? error.message : error);
      await closePool().catch(() => undefined);
      process.exit(1);
    });
}

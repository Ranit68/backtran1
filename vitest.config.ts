import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

/**
 * The source is ESM with `moduleResolution: NodeNext`, so every internal import
 * is written as `./foo.js` even though the file on disk is `./foo.ts`. Node
 * resolves that natively after compilation; Vite does not, so this plugin maps
 * the compiled-style specifier back to the TypeScript file. Without it every
 * test suite fails to load.
 */
const resolveTsFromJsSpecifier = {
  name: "transport-resolve-ts-from-js-specifier",
  enforce: "pre" as const,
  resolveId(source: string, importer: string | undefined) {
    if (!source.endsWith(".js") || !importer) return null;
    const candidate = path.resolve(path.dirname(importer), source.replace(/\.js$/, ".ts"));
    if (candidate.startsWith(projectRoot) && existsSync(candidate)) return candidate;
    return null;
  },
};

export default defineConfig({
  plugins: [resolveTsFromJsSpecifier],
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Forks, not threads: the app opens a pg pool and Fastify binds internal
    // state, both of which behave better in a real process.
    pool: "forks",
    testTimeout: 20_000,
    hookTimeout: 20_000,
    /**
     * The contract suite asserts the no-database behaviour: the app must boot,
     * /api/health must be 200, and data endpoints must return
     * DATABASE_NOT_CONFIGURED. Those assertions are only meaningful if the
     * suite controls its own environment, so DATABASE_URL and ADMIN_KEY are
     * pinned to empty here.
     *
     * Empty means "absent": env.ts treats a blank value as unset rather than as
     * a validation error, and dotenv does not overwrite variables that are
     * already present in process.env. Without this, adding a real .env makes
     * the suite fail for reasons that have nothing to do with the code.
     */
    env: {
      NODE_ENV: "test",
      DATABASE_URL: "",
      ADMIN_KEY: "",
    },
  },
});

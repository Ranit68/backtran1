import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyReply } from "fastify";

/**
 * Serves the single-page frontend.
 *
 * The app is a JSON API that also has to hand back `public/index.html` for
 * anything that is not an API call, because that is what makes the site work
 * when it is deployed as one serverless function behind a catch-all. Relying on
 * the host to serve the file is not enough: the deployment has to be correct in
 * two places at once, and when it is not, every page load is a 500 rather than
 * a degraded one. Serving it here means there is a single source of truth.
 */

const INDEX_RELATIVE = join("public", "index.html");

/**
 * Candidate locations, most likely first.
 *
 * The compiled module's own path is not a reliable anchor: `tsc` writes to
 * `dist/frontend.js` from one config and `dist/src/frontend.js` from another, and
 * a serverless runtime flattens the bundle again. So the module directory is
 * walked upwards looking for the file, and the working directory is tried first
 * because that is what a function runtime resolves against.
 */
function candidatePaths(): string[] {
  const paths = [resolve(process.cwd(), INDEX_RELATIVE)];
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    paths.push(resolve(dir, INDEX_RELATIVE));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return paths;
}

let cached: string | null | undefined;

/** The page source, or null when it cannot be found. Cached after the first call. */
export function readFrontend(): string | null {
  if (cached !== undefined) return cached;
  for (const path of candidatePaths()) {
    try {
      cached = readFileSync(path, "utf8");
      return cached;
    } catch {
      // Try the next candidate.
    }
  }
  cached = null;
  return cached;
}

/**
 * Sends the frontend for a page request.
 *
 * Returns false when the file is unavailable, so the caller can fall back to its
 * normal 404 rather than reporting a success it did not deliver.
 */
export function sendFrontend(reply: FastifyReply): boolean {
  const html = readFrontend();
  if (html === null) return false;
  reply.header("content-type", "text/html; charset=utf-8");
  // The shell must not be cached, or a deploy leaves browsers on old markup
  // that calls endpoints which no longer exist.
  reply.header("cache-control", "no-cache");
  void reply.send(html);
  return true;
}

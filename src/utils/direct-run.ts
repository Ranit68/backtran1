import { argv } from "node:process";
import { pathToFileURL } from "node:url";

/**
 * True when the module identified by `moduleUrl` is the entry point this
 * process was launched with, so a file can be both importable and runnable
 * from the CLI.
 *
 * Two traps this avoids, both of which make `npm run migrate` exit 0 having
 * silently done nothing:
 *
 * 1. The obvious comparison, `import.meta.url === `file://${process.argv[1]}``,
 *    is wrong on Windows. Node reports a module as `file:///C:/app/x.js` while
 *    that template produces `file://C:/app/x.js`, so the strings never match.
 * 2. The caller must pass its own `import.meta.url`. A helper cannot default
 *    this: `import.meta.url` inside a module always refers to that module, so
 *    a default parameter would silently compare the helper against the entry
 *    point and report false.
 */
export function isDirectRun(moduleUrl: string): boolean {
  const entry = argv[1];
  if (entry === undefined || entry.length === 0) return false;
  return moduleUrl === pathToFileURL(entry).href;
}

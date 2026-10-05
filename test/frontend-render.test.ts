import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Frontend rendering tests.
 *
 * The frontend is one inline script in a single HTML file, so these pull the
 * functions out of it and run them directly. That is deliberate: the bug this
 * covers was invisible to every other test in the repo. The backend returned
 * perfectly good Ferry and Tram routes, and the endpoints were correct, but the
 * list renderer read Bus-shaped camelCase fields that those two modes never
 * send, so each row rendered as nothing but the operator and an empty id.
 * Nothing was red, because nothing on the server was wrong.
 *
 * The payloads below are copied from live responses, not invented, so a rename
 * on either side has to be reflected here.
 */

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

/**
 * Returns the source of one function, brace balanced while ignoring braces that
 * belong to strings, template literals or comments.
 */
function extract(name: string): string {
  const starts = [`function ${name}(`, `var ${name} = function (`, `var ${name} = function(`];
  let from = -1;
  for (const pattern of starts) {
    const at = html.indexOf(pattern);
    if (at !== -1) { from = at; break; }
  }
  if (from === -1) throw new Error(`${name} was not found in public/index.html`);

  let state: "code" | "line" | "block" | "sq" | "dq" | "tpl" | "re" = "code";
  let inClass = false;
  let last = "";
  let depth = 0;
  // Walk from the start of the declaration so the returned text is the whole
  // function, not just its body. Slicing from the first brace yields "{ ... }",
  // which parses as a block and leaves the function name undefined.
  for (let i = from; i < html.length; i += 1) {
    const c = html[i]!;
    const next = html[i + 1] ?? "";
    if (state === "line") { if (c === "\n") state = "code"; continue; }
    if (state === "block") { if (c === "*" && next === "/") { i += 1; state = "code"; } continue; }
    if (state === "re") {
      // A regex body may contain quotes, braces and slashes, so it is skipped
      // wholesale. Without this the quotes in /[&<>"']/g open a "string" that
      // never closes and the extraction runs off the end of the function.
      if (c === "\\") { i += 1; continue; }
      if (c === "[") inClass = true;
      else if (c === "]") inClass = false;
      else if (c === "/" && !inClass) state = "code";
      continue;
    }
    if (state === "sq" || state === "dq" || state === "tpl") {
      const quote = state === "sq" ? "'" : state === "dq" ? '"' : "`";
      if (c === "\\") { i += 1; continue; }
      if (c === quote) { state = "code"; last = c; }
      continue;
    }
    if (c === "/" && next === "/") { i += 1; state = "line"; continue; }
    if (c === "/" && next === "*") { i += 1; state = "block"; continue; }
    if (c === "/" && /(?:^|[=(,:[!&|?{};+\-*%~^<>])/.test(last)) { state = "re"; inClass = false; continue; }
    if (c === "'") { state = "sq"; continue; }
    if (c === '"') { state = "dq"; continue; }
    if (c === "`") { state = "tpl"; continue; }
    if (c === "{") depth += 1;
    if (c === "}") { depth -= 1; if (depth === 0) return html.slice(from, i + 1); }
    if (!/\s/.test(c)) last = c;
  }
  throw new Error(`unbalanced braces while reading ${name}`);
}

/** Loads the named functions out of the page into a callable sandbox. */
function load(...names: string[]): Record<string, unknown> {
  // MODE_VAR backs modeColor, which is a plain data object rather than a
  // function, so it is restated here instead of extracted.
  const prelude =
    'var MODE_VAR = { BUS: "var(--bus)", METRO: "var(--metro)", FERRY: "var(--ferry)", TRAM: "var(--tram)" };\n';
  const source = names.map(extract).join("\n");
  return new Function(`${prelude}${source}\nreturn { ${names.join(", ")} };`)() as Record<string, unknown>;
}

type Renderer = (item: unknown, mode: string) => string;

const { ferryTramRow, busMetroRow, prettyStatus } = load(
  "esc",
  "modeColor",
  "prettyStatus",
  "busMetroRow",
  "ferryTramRow"
) as {
  ferryTramRow: Renderer;
  busMetroRow: Renderer;
  prettyStatus: (value: unknown) => string;
};

/** A trimmed copy of GET /api/ferry/routes, exactly as the API returns it. */
const FERRY = {
  route_id: "F001",
  route_name: "HOWRAH-ARMENIAN",
  operator: "WBTC/HNJPSS",
  from_ghat: "Howrah",
  to_ghat: "Armenian Ghat",
  intermediate_ghats: null,
  first_departure: "08:00:00",
  last_departure: "20:00:00",
  frequency_minutes: 10,
  fare_inr: "10",
  fare_range_inr: null,
  service_days: ["MON", "TUE"],
  status: "OPERATIONAL"
};

/** A trimmed copy of GET /api/tram/routes. */
const TRAM = {
  route_id: "TRAM25",
  route_no: "25",
  route_name: "Gariahat-Esplanade",
  operator: "WBTC / CTC",
  from_terminal: "Gariahat Depot",
  to_terminal: "Esplanade",
  status: "OPERATIONAL",
  service_type: "REGULAR_COMMUTER",
  service_pattern: "IRREGULAR",
  fare_range_inr: "10-30",
  notes: null
};

/** Bus and Metro are reshaped to camelCase by their controllers. */
const BUS = {
  routeNo: "AC-3",
  firstStop: "Barasat",
  lastStop: "Vivekananda Road",
  operator: "WBTC",
  stopCount: 5,
  averageTripMinutes: 69,
  depot: "Barasat Depot",
  hasTimetable: true
};

const METRO = {
  routeNo: "BLUE",
  name: "North-South / Blue Line",
  firstStop: "Dakshineswar",
  lastStop: "Kavi Subhash",
  operator: "Metro Railway",
  stopCount: 26,
  stationsWithTimetable: 5,
  hasTimetable: true,
  mode: "METRO"
};

describe("ferry route row", () => {
  const row = ferryTramRow(FERRY, "FERRY");

  it("shows the route id, name and both ghats", () => {
    expect(row).toContain("F001");
    expect(row).toContain("HOWRAH-ARMENIAN");
    expect(row).toContain("Howrah");
    expect(row).toContain("Armenian Ghat");
  });

  it("links to the route so the detail view can be opened", () => {
    // data-no was empty before, which requested /ferry/routes/ with no route
    // in it and rendered the wrong page.
    expect(row).toContain('data-no="F001"');
  });

  it("surfaces the operator, frequency and fare", () => {
    expect(row).toContain("WBTC/HNJPSS");
    expect(row).toContain("every 10 min");
    expect(row).toContain("Rs 10");
  });

  it("renders nothing undefined for a payload with null optional fields", () => {
    expect(row).not.toContain("undefined");
    expect(row).not.toContain("null");
    expect(row).not.toContain("NaN");
  });
});

describe("tram route row", () => {
  const row = ferryTramRow(TRAM, "TRAM");

  it("labels the row with the route number riders recognise", () => {
    expect(row).toContain(">25<");
  });

  it("shows the route name and both terminals", () => {
    expect(row).toContain("Gariahat-Esplanade");
    expect(row).toContain("Gariahat Depot");
    expect(row).toContain("Esplanade");
  });

  it("links by route_id, not route_no, because that is what the stops call takes", () => {
    expect(row).toContain('data-no="TRAM25"');
  });

  it("renders nothing undefined", () => {
    expect(row).not.toContain("undefined");
    expect(row).not.toContain("NaN");
  });
});

describe("bus and metro rows are unaffected by the split", () => {
  it("still renders a bus route with its stops and depot", () => {
    const row = busMetroRow(BUS, "BUS");
    expect(row).toContain('data-no="AC-3"');
    expect(row).toContain("Barasat");
    expect(row).toContain("Vivekananda Road");
    expect(row).toContain("5 stops");
    expect(row).toContain("69 min end to end");
  });

  it("still renders a metro line with its name and station count", () => {
    const row = busMetroRow(METRO, "METRO");
    expect(row).toContain('data-no="BLUE"');
    expect(row).toContain("North-South / Blue Line");
    expect(row).toContain("26 stations");
    expect(row).toContain("5 with printed times");
  });
});

describe("prettyStatus", () => {
  it("turns a stored enum into a label", () => {
    expect(prettyStatus("OPERATIONAL")).toBe("Operational");
    expect(prettyStatus("REGULAR_COMMUTER")).toBe("Regular Commuter");
  });

  it("copes with nothing", () => {
    expect(prettyStatus("")).toBe("");
  });
});

describe("bundled page", () => {
  it("embeds the current public/index.html rather than a stale copy", async () => {
    // src/frontend.ts serves the page out of the bundle on Vercel, so a stale
    // generated file means the deployed site runs old markup that calls endpoints
    // which no longer exist, while the repo and local dev both look correct.
    const { FRONTEND_HTML } = await import("../src/frontend-html.generated.js");
    expect(FRONTEND_HTML).toBe(readFileSync(new URL("../public/index.html", import.meta.url), "utf8"));
  });
});

describe("wiring", () => {
  it("renders ferry and tram rows through their own renderer", () => {
    // Without this the two modes fell through to the bus renderer again. The row
    // tests above call ferryTramRow directly, so they stayed green even with
    // the dispatch removed, which is how this went unnoticed a second time.
    expect(html).toContain('if (mode === "FERRY" || mode === "TRAM") return ferryTramRow(r, mode);');
  });

  it("dispatches the detail view to a Ferry renderer", () => {
    // Both modes used to fall through to paintBusRoute, which read firstStop
    // and data.stops and so showed "No stop list returned." for every one.
    expect(html).toContain('if (mode === "FERRY") return paintFerryRoute');
    expect(html).toContain('if (mode === "TRAM") return paintTramRoute');
  });

  it("declares a sort for every mode the routes panel offers", () => {
    for (const mode of ["BUS", "METRO", "FERRY", "TRAM"]) {
      expect(html).toMatch(new RegExp(`${mode}:\\s*\\[`));
    }
  });

  it("sends a sort only when one is selected", () => {
    // The Ferry and Tram endpoints ignore ordering, so the control is hidden
    // and an empty sort must not still be sent as a parameter.
    expect(html).toContain("if (sort) query.sort = sort;");
  });
});

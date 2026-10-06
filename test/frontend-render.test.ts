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
    // A regex literal may only follow an operator, an opening bracket, a comma,
    // a colon or the very start of the slice. Testing `^` as an alternative was
    // the bug here: it matches the empty string at index 0, so the guard was
    // always true and every "/" began a phantom regex. That silently corrupted
    // any function containing a division, such as `Math.round(delta / 60)`.
    if (c === "/" && (last === "" || /[=(,:[!&|?{};+\-*%~^<>]/.test(last))) {
      state = "re";
      inClass = false;
      continue;
    }
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

const { ferryTramRow, busMetroRow, prettyStatus, fareAmount, fareChip } = load(
  "esc",
  "modeColor",
  "prettyStatus",
  "fareAmount",
  "fareChip",
  "busMetroRow",
  "ferryTramRow"
) as {
  ferryTramRow: Renderer;
  busMetroRow: Renderer;
  prettyStatus: (value: unknown) => string;
  fareAmount: (r: Record<string, unknown>, mode: string) => { text: string; note: string; known: boolean };
  fareChip: (r: Record<string, unknown>, mode: string, big?: boolean) => string;
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
    // The fare moved out of the separator-joined meta line and into its own
    // chip, where it is legible instead of being one item among several.
    expect(row).toContain("\u20b910");
    expect(row).toContain("per crossing");
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

describe("fare", () => {
  const { fareAmount, fareChip, ferryTramRow, serviceCard } = load(
    "esc",
    "modeColor",
    "prettyStatus",
    "fareAmount",
    "fareChip",
    "ferryTramRow",
    "serviceCard"
  ) as {
    fareAmount: (r: Record<string, unknown>, mode: string) => { text: string; note: string; known: boolean };
    fareChip: (r: Record<string, unknown>, mode: string, big?: boolean) => string;
    ferryTramRow: Renderer;
    serviceCard: Renderer;
  };

  // Copied from live /api/ferry/routes responses.
  const f001 = { route_id: "F001", route_name: "HOWRAH-ARMENIAN", from_ghat: "Howrah", to_ghat: "Armenian Ghat", operator: "WBTC/HNJPSS", frequency_minutes: 10, fare_inr: "10", fare_range_inr: null, status: "OPERATIONAL" };
  const f002 = { ...f001, route_id: "F002", route_name: "HOWRAH-FAIRLIE", fare_inr: "6", fare_range_inr: "6" };
  const f005 = { ...f001, route_id: "F005", route_name: "HOWRAH-BAGBAZAR", fare_inr: "6", fare_range_inr: "6-7" };
  const f006 = { ...f001, route_id: "F006", route_name: "HOWRAH-KASHIPUR", fare_inr: null, fare_range_inr: null };

  it("shows a single fare as an amount", () => {
    expect(fareAmount(f001, "FERRY")).toEqual({ text: "\u20b910", note: "per crossing", known: true });
  });

  it("prefers the band when it says more than the single fare", () => {
    // F005 quotes 6 but bands 6-7; the band is the useful half.
    expect(fareAmount(f005, "FERRY").text).toBe("\u20b96-7");
  });

  it("does not print the same fare twice when the two fields agree", () => {
    // F002 sends fare_inr 6 and fare_range_inr 6. Rendering both produced
    // "Rs 6 Rs 6" in the detail panel, because only the list row had the guard.
    const f = fareAmount(f002, "FERRY");
    expect(f.text).toBe("\u20b96");
    const chips = (fareChip(f002, "FERRY").match(/\u20b9/g) ?? []).length;
    expect(chips).toBe(1);
    for (const rendered of [ferryTramRow(f002, "FERRY"), serviceCard(f002, "FERRY")]) {
      expect(rendered.match(/\u20b9/g) ?? []).toHaveLength(1);
    }
  });

  it("states that a fare is unverified instead of leaving it blank", () => {
    // Silence reads as free. F006 genuinely has no published fare, and the
    // backend quotes null rather than 0 precisely so "unknown" is not "none".
    const f = fareAmount(f006, "FERRY");
    expect(f.known).toBe(false);
    expect(f.text).toBe("\u2014");
    expect(fareChip(f006, "FERRY")).toContain("fare not verified");
    expect(ferryTramRow(f006, "FERRY")).toContain("fare not verified");
  });

  it("puts the fare on the row and on the card", () => {
    for (const rendered of [ferryTramRow(f001, "FERRY"), serviceCard(f001, "FERRY")]) {
      expect(rendered).toContain("\u20b910");
    }
  });

  it("bills a ferry per crossing and a tram per ride", () => {
    // A crossing is a river crossing. Reusing the wording on a land service is
    // small, but it is the kind of detail that undermines the rest of the page.
    expect(fareAmount(f001, "FERRY").note).toBe("per crossing");
    expect(fareAmount({ fare_range_inr: "5-10" }, "TRAM").note).toBe("per ride");
  });

  it("marks the detail panel's fare as unknown rather than dropping it", () => {
    // paintFerryRoute and paintTramRoute used to push both fare fields into a
    // separator-joined string; they now render the chip instead.
    expect(html).not.toContain('bits.push("Rs " + d.fare_inr)');
    expect(html).not.toContain('bits.push("Rs " + d.fare_range_inr)');
    expect(html).toContain('fareChip(d, "FERRY", true)');
    expect(html).toContain('fareChip(d, "TRAM", true)');
  });
});

describe("ferry and tram panels", () => {
  it("gives each service its own tab", () => {
    expect(html).toContain('id="t-ferry" aria-controls="p-ferry"');
    expect(html).toContain('id="t-tram" aria-controls="p-tram"');
    expect(html).toContain('id="p-ferry"');
    expect(html).toContain('id="p-tram"');
  });

  it("registers both panels so the tab handler can reach them", () => {
    // The handler loops over TABS and hides every panel it does not match, so a
    // section without an entry would never be reachable.
    expect(html).toContain('loadService("FERRY", "ferryList")');
    expect(html).toContain('loadService("TRAM", "tramList")');
  });

  it("scopes the detail loading box per host", () => {
    // A ferry detail and a routes detail can both sit in the DOM, so a bare id
    // would be duplicated and the painter would read the wrong one.
    expect(html).toContain('id="legsBox\' + uid + \'"');
    expect(html).toContain('id="stopsBox\' + uid + \'"');
  });
});

describe("app shell", () => {
  it("gives a phone a thumb-reachable dock", () => {
    // The tab strip needs a sideways swipe to reach its last item and puts every
    // target at the top of the screen. On mobile it leaves the layout and the
    // accessibility tree, so a dock has to take over.
    expect(html).toContain('class="dock" id="dock"');
    expect(html).toContain(".tabs{display:none}");
    expect(html).toContain(".dock{display:flex}");
    expect(html).toContain("padding-bottom:calc(64px + env(safe-area-inset-bottom,0px))");
  });

  it("keeps the dock to five targets and spills the rest into the sheet", () => {
    const dock = html.slice(html.indexOf('id="dock"'), html.indexOf("</nav>", html.indexOf('id="dock"')));
    expect((dock.match(/class="dock__item"/g) || []).length).toBe(5);
    expect((dock.match(/data-go="/g) || []).length).toBe(4);
    for (const go of ["plan", "routes", "ferry", "tram"]) expect(dock).toContain(`data-go="${go}"`);
    // The other four panels are deliberately not dock targets.
    for (const go of ["stops", "network", "community", "api"]) expect(dock).not.toContain(`data-go="${go}"`);
    for (const go of ["stops", "network", "community", "api"]) expect(html).toContain(`data-go="${go}"`);
  });

  it("mirrors whichever panel is open onto the dock", () => {
    // Two sets of controls for one set of panels only stay in step if a single
    // function drives both.
    expect(html).toContain("function selectTab(name)");
    expect(html).toContain(".dock__item[data-go]");
    expect(html).toContain('b.setAttribute("aria-current"');
    expect(html).toContain('MORE.indexOf(name) > -1 ? "on" : "off"');
  });

  it("shows a shape-matched placeholder instead of a spinner while loading", () => {
    // A centred spinner in an empty box reads as an error. A grey placeholder in
    // the shape of the arriving rows reads as loading.
    expect(html).toContain("function skRows(");
    expect(html).toContain("function skCards(");
    expect(html).toContain("function skLines(");
    const body = html.slice(html.indexOf("<body"));
    // Only the two inside-button spinners survive, which is the correct use.
    expect((body.match(/class="spin"/g) || []).length).toBe(2);
  });
});

describe("community feed paging", () => {
  it("asks the API for the window it is showing", () => {
    // hasMore is only worth printing if the client can act on it, so the feed
    // request has to carry the offset the client was told about.
    expect(html).toContain("{ query: { limit: cmPage, offset: cmOffset } }");
  });

  it("reaches older reports instead of promising them and stopping", () => {
    // The old copy said "older reports not loaded" with no way to load them,
    // which is a dead end rather than an honest limit.
    expect(html).toContain('id="cmOlder"');
    expect(html).toContain("cmOffset += cmShown;");
    expect(html).not.toContain("older reports not loaded");
  });

  it("steps back to a window it remembers rather than recomputing one", () => {
    // A page is only as long as the posts still alive inside it, so a fixed
    // "offset minus page size" walks back to the wrong place as soon as
    // something expires. The offset is pushed before advancing instead.
    expect(html).toContain("cmHistory.push(cmOffset);");
    expect(html).toContain("cmOffset = cmHistory.pop();");
    expect(html).toContain('id="cmNewer"');
  });

  it("returns to the newest window when the one on screen has expired", () => {
    // Posts expire around the clock, so a window can empty out while it is on
    // screen. Landing the rider one page past the end with no way back would
    // need a route retype to escape; the offset guard keeps it to one retry.
    expect(html).toContain("if (!list.length && feed.offset > 0) {");
    expect(html).toContain("return loadCommunity();");
  });

  it("leaves the pager hidden when there is nothing to step through", () => {
    expect(html).toContain('id="cmPager" hidden');
    expect(html).toContain('$("#cmPager").hidden = !cmScope || (!cmHasMore && !cmHistory.length);');
    // display:flex would otherwise beat the UA rule for [hidden] and leave an
    // empty row sitting above the note.
    expect(html).toContain(".cm-pager[hidden]{display:none}");
  });

  it("brings a rider back to the top after they post", () => {
    // Their own report is in the newest window, so posting from page three
    // would reload a page that does not contain it.
    const post = extract("postCommunity");
    expect(post).toContain("cmReset();");
    expect(post).toContain("loadCommunity();");
  });

  it("offers the community feed in the API explorer", () => {
    // Community was the one feature with no entry there, so its endpoints could
    // not be exercised from the browser like every other group. Two path
    // segments is also what pv's comma list exists for.
    expect(html).toContain('p: "/community/:mode/:route", pv: "mode,route"');
    expect(html).toContain("var pvs = (def.pv || \"\").split(\",\");");
  });
});

describe("community route picker", () => {
  const { cmRoutePairs } = load("cmRoutePairs") as {
    cmRoutePairs: (mode: string, items: unknown[]) => { value: string; label: string }[];
  };

  it("is a dropdown, not a field a rider has to know the route number for", () => {
    // The old field was free text, which asked a rider to spell "North-South /
    // Blue Line" correctly and 404'd on anything they got wrong.
    expect(html).toContain('<select class="inp" id="cmRoute">');
    expect(html).not.toMatch(/<input[^>]*id="cmRoute"/);
    expect(html).toContain('$("#cmRoute").addEventListener("change"');
  });

  it("sends the identifier the feed's resolver matches on", () => {
    // Copied from live /api/<mode>/routes responses. A display name is not a
    // safe value: it is neither guaranteed unique nor what the resolver prefers.
    const metro = cmRoutePairs("METRO", [{ routeNo: "BLUE", name: "North-South / Blue Line" }]);
    expect(metro).toEqual([{ value: "BLUE", label: "BLUE \u00b7 North-South / Blue Line" }]);

    expect(cmRoutePairs("BUS", [{ routeNo: "AC-3", depot: "Barasat Depot" }])[0]!.value).toBe("AC-3");
    expect(cmRoutePairs("FERRY", [{ route_id: "F001", route_name: "HOWRAH-ARMENIAN" }])[0]!.value).toBe("F001");
    expect(cmRoutePairs("TRAM", [{ route_id: "TRAM5", route_no: "25", route_name: "Gariahat-Esplanade" }])[0]!.value)
      .toBe("TRAM5");
  });

  it("offers nothing that would 404", () => {
    // A row with no identifier still renders in the routes panel, but as a
    // community choice it would produce an empty path segment.
    expect(cmRoutePairs("BUS", [{ routeNo: null, depot: "Khidirpur Depot" }, { routeNo: "AC-3" }]))
      .toEqual([{ value: "AC-3", label: "AC-3" }]);
  });

  it("loads the full list for the mode and ignores a response that arrives late", () => {
    expect(html).toContain('api("/" + mode.toLowerCase() + "/routes", { query: { limit: 200 } })');
    // Switching Metro to Bus while Metro's list is in flight must not repaint
    // the picker with Metro's routes under Bus.
    expect(html).toContain('if ($("#cmMode").value !== mode) return;');
  });

  it("keeps the rider's choice when the same list comes back", () => {
    expect(html).toContain("if (keep && pairs.some(function (p) { return p.value === keep; })) sel.value = keep;");
  });
});

describe("departures", () => {
  const { projectDepartures, depCountdown, hhmmToMin, minToHHMM } = load(
    "nowMin",
    "runsToday",
    "hhmmToMin",
    "minToHHMM",
    "projectDepartures",
    "depCountdown"
  ) as {
    projectDepartures: (s: Record<string, unknown>[], limit?: number, clock?: number) => { min: number }[];
    depCountdown: (min: number, clock?: number) => string;
    hhmmToMin: (v: string | null) => number | null;
    minToHHMM: (m: number) => string;
  };

  // F001 as published: 08:00 to 20:00, every 10 minutes, daily.
  const daily = [
    { service_days: "DAILY", first_departure: "08:00:00", last_departure: "20:00:00", frequency_minutes: 10 },
  ];
  // TRAM5 as published: irregular, so nothing may be projected from it.
  const irregular = [
    { service_days: "DAILY", service_pattern: "IRREGULAR", first_departure: null, last_departure: null, frequency_minutes: null },
  ];
  const NINE_SEVEN = 9 * 60 + 7;

  it("projects from the headway when a timetable is published", () => {
    // Clock is passed in, so the result does not depend on when the suite runs.
    expect(projectDepartures(daily, 3, NINE_SEVEN).map((d) => minToHHMM(d.min)))
      .toEqual(["09:10", "09:20", "09:30"]);
  });

  it("projects nothing from a service with no fixed timetable", () => {
    // The tram record is honest about being irregular. Inventing a headway here
    // would be the most damaging thing this app could do.
    expect(projectDepartures(irregular, 6)).toEqual([]);
  });

  it("skips a service that does not run today", () => {
    const weekend = [{ service_days: "SATURDAY,SUNDAY,HOLIDAY", first_departure: "10:00", last_departure: "18:00", frequency_minutes: 30 }];
    const today = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"][new Date().getDay()];
    const isWeekend = today === "SATURDAY" || today === "SUNDAY";
    expect(projectDepartures(weekend, 6).length > 0).toBe(isWeekend);
  });

  it("never repeats a minute within one route", () => {
    const out = projectDepartures([...daily, ...daily], 20, NINE_SEVEN);
    expect(out.length).toBe(new Set(out.map((d) => d.min)).size);
  });

  it("labels a rolled-over departure as tomorrow, and today as today", () => {
    // A 00:10 clock still faces today's 08:00. Calling that "tomorrow" is the
    // kind of small lie that makes a departures board untrustworthy.
    expect(depCountdown(480, 10)).toBe("in 8 hr");
    expect(depCountdown(1920, 20 * 60 + 1)).toBe("tomorrow 08:00");
    expect(depCountdown(9 * 60 + 10, NINE_SEVEN)).toBe("in 3 min");
  });

  it("rolls past the last departure instead of showing an empty board", () => {
    // At 20:01 the 08:00-20:00 service is finished. Showing tomorrow's opening
    // times is useful; showing nothing reads as "no service today".
    const out = projectDepartures(daily, 3, 20 * 60 + 1);
    expect(out.map((d) => minToHHMM(d.min))).toEqual(["08:00", "08:10", "08:20"]);
    expect(out).toHaveLength(3);
    expect(out[0]!.min).toBeGreaterThan(1440);
  });

  it("parses times defensively", () => {
    expect(hhmmToMin("08:00:00")).toBe(480);
    expect(hhmmToMin(null)).toBeNull();
    expect(hhmmToMin("")).toBeNull();
    expect(minToHHMM(0)).toBe("00:00");
    expect(minToHHMM(1440)).toBe("00:00");
  });

  it("states that the board is not a live feed", () => {
    // Projected times are only trustworthy if the reader knows what they are.
    expect(html).toContain("not a live vehicle feed");
    expect(html).toContain("computed at");
  });
});

describe("heritage and policy notes", () => {
  it("shows weekend heritage rides apart from routable services", () => {
    // The API marks these informational only. Filing them with the daily routes
    // would suggest they can be planned on.
    expect(html).toContain("loadHeritage()");
    expect(html).toContain('id="tramHeritage"');
    expect(html).toContain("never used for journey planning");
  });

  it("surfaces the API's own fare and timetable policy", () => {
    // The API publishes why an unverified fare is null rather than 0. Passing
    // that on is what stops a blank fare reading as a bug.
    expect(html).toContain("function loadPolicy(");
    expect(html).toContain("d.farePolicy");
    expect(html).toContain("d.timetablePolicy");
  });

  it("explains missing data instead of naming the missing field", () => {
    // The phrase survives only in a doc comment that described the old bug.
    expect(html).not.toContain("No crossing list returned.");
    expect(html).not.toContain("No station list returned.");
    expect(html).toContain("No stop order published");
  });
});

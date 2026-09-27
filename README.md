# Kolkata Transport Backend

TypeScript + Fastify REST API over Kolkata **bus** and **metro** data, backed by Supabase/PostgreSQL and deployable to Vercel.

Built from `Kolkata_Multimodal_Transport_Backend_Specification.docx`. Bus data is imported from CSV. Metro is read from four supplied tables that the specification marks read-only, so the API serves them as-is and never writes to them. Ferry endpoints are registered but deliberately return `501`, because no ferry data was supplied and the specification forbids inventing a schema. Tram has been withdrawn: its tables and migration are left untouched, and its endpoints return `410`.

---

## Contents

- [What is implemented](#what-is-implemented)
- [Quick start](#quick-start)
- [Environment](#environment)
- [Database setup](#database-setup)
- [Data import](#data-import)
- [Response envelope](#response-envelope)
- [Endpoints](#endpoints)
  - [Health](#health)
  - [Search](#search)
  - [Bus](#bus)
  - [Metro](#metro)
  - [Tram (withdrawn)](#tram-withdrawn)
  - [Journey planning](#journey-planning)
  - [Graph introspection](#graph-introspection)
  - [Ferry (not configured)](#ferry-not-configured)
  - [Admin](#admin)
- [Error codes](#error-codes)
- [How the planner works](#how-the-planner-works)
- [Data quality decisions](#data-quality-decisions)
- [Testing](#testing)
- [Deploying to Vercel](#deploying-to-vercel)
- [Project layout](#project-layout)

---

## What is implemented

| Mode | Status | Source data | Timetable |
| --- | --- | --- | --- |
| Bus | Working | `wbtc_bus_routes.csv` (48 routes, 1,224 rows) — 47 servable, see [Data import](#data-import) | `wbtc_bus_timetable_final.csv` (3,130 rows, 67 route numbers) — but only `AC-3` and `AC-4` also exist in the route-stop file, so 2 of 66 graph routes get real ride times |
| Metro | Working | Four supplied read-only tables: `metro_routes`, `metro_stations`, `metro_trips`, `metro_timetable_checkpoints` (6 lines, 80 line/station entries, 1,720 trips, 5,849 checkpoints) | Supplied for 5 of 6 lines. Per-hop times are measured between consecutive printed times, and per-run times are interpolated or read directly. See [Metro data limits](#metro-data-limits) |
| Tram | Withdrawn (`410 TRAM_SERVICE_WITHDRAWN`) | Legacy tables left untouched | — |
| Ferry | `501 FERRY_NOT_CONFIGURED` | None supplied; spec forbids inventing it | — |

The application **boots without a database**. Data endpoints then return `503 DATABASE_NOT_CONFIGURED` rather than crashing, which lets the API be built, started, and smoke-tested before a Supabase project exists.

---

## Quick start

```bash
npm install
cp .env.example .env        # optional for a first run; the app boots without it
npm run dev                 # http://localhost:3000
```

```bash
curl http://localhost:3000/api/health
```

| Script | Purpose |
| --- | --- |
| `npm run dev` | Watch-mode server on `PORT` (default 3000) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled server |
| `npm run typecheck` | Type-check without emitting |
| `npm run migrate` | Apply `src/db/migrations/*.sql` in order |
| `npm run import:all` | Import both bus CSVs (replaces those tables) |
| `npm run import:bus-routes` | Import only bus route stops |
| `npm run import:bus-timetable` | Import only the bus timetable |
| `npm run typecheck:test` | Type-check the test files |
| `npm run verify` | `typecheck` + `typecheck:test` + `test` + `build` |
| `npm test` | Run the test suite |

Metro has no import script because its four tables are supplied and read-only.

---

## Environment

All variables are documented in `.env.example`. The ones that change behaviour rather than just wiring:

| Variable | Default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | *(unset)* | Supabase session-pooler URI. Absent → data endpoints return `DATABASE_NOT_CONFIGURED`. |
| `ADMIN_KEY` | *(unset)* | Required by the admin routes, sent as `x-admin-key`. **Unset means the admin routes are disabled (503), never open.** |
| `CORS_ORIGINS` | `*` | Comma-separated origins for browsers. Name real domains in production. |
| `MAX_TRANSFER_DISTANCE_METERS` | `300` | Hard ceiling on a walkable transfer. |
| `DEFAULT_TRANSFER_MINUTES` | `5` | Transfer penalty when a pair has no coordinates — which is the case for all bus and metro data, since neither source carries any. |
| `TRANSFER_NAME_SIMILARITY_THRESHOLD` | `0.9` | Minimum name similarity to link two stops when coordinates are missing. |
| `MIN_INTERCHANGE_MINUTES` | `5` | Allowance for changing vehicle at a stop, used when the change happens at the **same** stop (so no walk is involved). Reported as a `TRANSFER` segment with `timingConfidence: "ESTIMATED"`, never as measured data. |
| `GRAPH_CACHE_TTL_SECONDS` | `900` | How long a built graph stays fresh in memory. |
| `GRAPH_REBUILD_MIN_INTERVAL_SECONDS` | `30` | Floor between rebuilds, so a burst of traffic after an import cannot stampede the database. |
| `DATA_DIR` | `data` | Folder holding the source CSVs. Also probed at `~/DATA_DIR` and `~/Downloads`. |

---

## Database setup

```bash
# .env must contain DATABASE_URL first
npm run migrate
```

| Migration | Contents |
| --- | --- |
| `001_create_bus_route_stops.sql` | `bus_route_stops` — operator written as a constant `WBTC`; empty `depot` → `NULL` |
| `002_create_bus_timetables.sql` | `bus_timetables` — the timetable's own operator (`CSTC`) is preserved; no unique constraint on `(route_no, trip_no, direction_id)` |
| `003_create_tram_route_stops.sql` | `tram_route_stops` — left in place after the Tram withdrawal; no longer read by the API |
| `004_transport_modes_and_route_stats.sql` | `transport_modes` registry, `route_trip_stats` derived from real timetable rows |
| `005_route_aliases_and_import_runs.sql` | `route_aliases` (route-number bridge) and `import_runs` (import audit trail) |

Migrations are recorded in `schema_migrations` and are **not** re-applied once recorded.

The four Metro tables (`metro_routes`, `metro_stations`, `metro_trips`, `metro_timetable_checkpoints`) are **not** created by any migration. They are supplied, and the specification marks them read-only, so this project never issues DDL or DML against them. Migrating a different Metro schema into the same database would be a data-loss risk, so it is deliberately not done.

Before running anything, the migration runner checks whether a table it is about to create already exists with different columns. If it does, it stops and lists the conflicting columns instead of touching the database, so a legacy schema is never silently half-migrated. The `CREATE TABLE` statements deliberately do **not** use `IF NOT EXISTS`: an incompatible pre-existing table must fail loudly, not be mistaken for a completed migration.

The five `*_legacy_backup` tables in this database are the original pre-migration tables, renamed and left in place with their row counts verified. They are not used by the API.

---

## Data import

```bash
npm run import:all
```

Reads the bus CSVs, validates every row, rejects and reports invalid rows rather than coercing them, and writes an `import_runs` record per file.

Imports **replace** their target table by default, so they are re-runnable (the unique indexes on `(operator, route_no, stop_sequence_no)` would otherwise reject a second append-only run).

The actual result of importing the supplied files:

```
wbtc_bus_routes.csv -> bus_route_stops
  read     : 1224
  inserted : 1223
  rejected : 1
  reject   : line 1198: stop_sequence_no must be an integer greater than 0 (bus)
  note     : 64 row(s) had an empty depot and were stored as NULL
  note     : WARNING: 1 route number(s) in the source have no usable row and will
             NOT appear in the API: AC-2 (every one of their rows was rejected)

wbtc_bus_timetable_final.csv -> bus_timetables
  read     : 3130
  inserted : 3130
  rejected : 0
  note     : 2995 of 3130 row(s) had an empty origin and were stored as NULL
  note     : 72 duplicate (route_no, trip_no, direction_id) key(s) kept as-is; the
             specification forbids a unique constraint there

wbtc_tram_routes.csv -> tram_route_stops
  read     : 526
  inserted : 526
  rejected : 0
  note     : 6 row(s) had an empty stop_sequence_no and were stored as SQL NULL (never 0)
```

The tram block above is a record of the historical import. The Tram import script and service have been removed; the table and its rows are left untouched and no longer read.

**Route `AC-2` disappears from the API, and that is correct.** Its only source row is a placeholder — stop name `(no stop data captured)`, empty `stop_sequence_no`, depot `Khidirpur Depot`. The row cannot be stored (`bus_route_stops.stop_sequence_no` is `NOT NULL` and the spec requires a value greater than 0) and inventing a sequence would be fabricating data. So the route has nothing to serve. The importer now checks for this explicitly and reports it, because a route silently vanishing from a 48-route list down to 47 is exactly the kind of change an operator needs told about rather than left to infer from a rejection count.

The source files contain 48 bus route numbers; the API serves 47.

After the timetable import, `route_trip_stats` is recomputed from observed `arrival_time − departure_time` values (services crossing midnight are handled). These are the numbers that let a bus ride be priced from real data rather than a guess — but see the coverage note in [How the planner works](#how-the-planner-works): only 2 of the 66 graph routes can actually be matched to them.

---

## Response envelope

Success:

```json
{ "success": true, "data": { } }
```

Failure:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "The request could not be validated.",
    "details": [{ "field": "q", "message": "q must not be empty" }]
  }
}
```

Errors always use the same shape, including 404s, malformed JSON, and rate-limit rejections. Paged payloads carry a `page` object:

```json
"page": { "total": 47, "limit": 50, "offset": 0, "returned": 47, "hasMore": false }
```

---

## Endpoints

All routes are under `/api`. `GET /api` returns a machine-readable index of them.

`GET /` returns the web frontend, not JSON. Every non-`/api` GET path is served
`public/index.html`, so deep links survive a reload; a missing `/api` path still
returns a JSON 404, so a broken client call is never mistaken for a page.

### Health

#### `GET /api/health`

Always `200`, even when the database is unreachable — a health check that goes red on a database hiccup gets the deployment killed. Component status is reported in the body.

```json
{
  "success": true,
  "data": {
    "status": "ok",
    "version": "1.0.0",
    "environment": "production",
    "uptimeSeconds": 812,
    "components": {
      "database": { "configured": true, "reachable": true },
      "graph": { "built": true, "stale": false, "nodeCount": 861, "lastBuiltAt": "2026-01-01T10:00:00.000Z", "lastBuildError": null }
    },
    "modes": {
      "BUS": { "implemented": true, "dataSource": "..." },
      "METRO": { "implemented": true, "dataSource": "..." },
      "TRAM": { "implemented": false, "reason": "TRAM_SERVICE_WITHDRAWN" },
      "FERRY": { "implemented": false, "reason": "..." }
    }
  }
}
```

### Search

#### `GET /api/search`

Multi-modal stop search with partial and fuzzy matching, returning the transport mode.

| Query | Type | Default | Notes |
| --- | --- | --- | --- |
| `q` | string, 1–120 chars | *required* | |
| `mode` | `ALL` \| `BUS` \| `METRO` \| `FERRY` | `ALL` | `TRAM` is not searchable; it has been withdrawn. |
| `limit` | int 1–100 | `20` | |

```bash
curl "http://localhost:3000/api/search?q=esplanade&limit=5"
```

```json
{
  "success": true,
  "data": {
    "query": "esplanade",
    "mode": "ALL",
    "count": 2,
    "results": [
      {
        "name": "Esplanade",
        "mode": "BUS",
        "modes": ["BUS", "METRO"],
        "operator": "WBTC",
        "routeCount": 14,
        "score": 0.92,
        "normalizedName": "esplanade",
        "nodeId": "bus:wbtc:esplanade"
      }
    ]
  }
}
```

A stop served by more than one mode is returned once, with both modes listed — that list is the signal an interchange is possible there. Placeholder names such as `(no stop data captured)` are stored unchanged but never returned as places.

### Bus

#### `GET /api/bus/routes`

| Query | Type | Default |
| --- | --- | --- |
| `operator` | string | — |
| `q` | string (partial route number) | — |
| `sort` | `route_no` \| `stop_count` \| `avg_trip_minutes` | `route_no` |
| `order` | `asc` \| `desc` | `asc` |
| `limit` | int 1–500 | `50` |
| `offset` | int ≥ 0 | `0` |

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "routeId": "bus:wbtc:ac-3",
        "routeNo": "AC-3",
        "mode": "BUS",
        "operator": "WBTC",
        "vehicleType": "bus",
        "depot": null,
        "stopCount": 34,
        "fullySequenced": true,
        "firstStop": "...",
        "lastStop": "...",
        "hasTimetable": true
      }
    ],
    "page": { "total": 47, "limit": 50, "offset": 0, "returned": 47, "hasMore": false }
  }
}
```

`total` is **47**, not 48: the source file lists 48 route numbers and `AC-2` has no storable row. See [Data import](#data-import).

#### `GET /api/bus/routes/:routeNo`

Full route with its ordered stops. Optional `?operator=`. Accepts a loosely-formatted route number (`ac3`, `ac 3`, `AC-3`) and falls back to a normalised match. `404 ROUTE_NOT_FOUND` if unknown.

`fullySequenced` is `false` when any stop has a `NULL` sequence, so a client can tell a verified stop order from source order.

Identifiers are built as `<mode>:<operator>:<route>` with the operator and route number lower-cased — `bus:wbtc:route:ac3` — and stop nodes as `<mode>:<operator>:stop:<normalized-stop-name>`, e.g. `bus:wbtc:stop:esplanade` and `metro:metro-railway:stop:esplanade`. They are opaque: pass them back to the API rather than parsing them. A name shared by a bus stop and a metro station therefore yields **two** nodes, which is what lets the planner treat it as a transfer rather than pretending the vehicles share a stop.

#### Route numbers that contain a slash

Some real route numbers contain `/` — `C-14/1` has 72 stops. A `/` inside a path segment is a path separator, so

```
GET /api/bus/routes/C-14%2F1          -> 200
GET /api/bus/routes/C-14/1            -> 404 (the router sees two segments)
```

Percent-encoding works and is the recommended form. Because every client that builds URLs by hand gets this wrong sooner or later, the same three endpoints also accept the number as a query parameter:

```
GET /api/bus/routes/by-number?routeNo=C-14%2F1
GET /api/bus/routes/by-number/stops?routeNo=C-14%2F1
GET /api/bus/routes/by-number/timetable?routeNo=C-14%2F1
```

`by-number` is a static path segment, so it takes precedence over `:routeNo`; a route genuinely numbered `by-number` would still be reachable through the query form.

#### `GET /api/bus/routes/:routeNo/stops`

```json
{
  "success": true,
  "data": {
    "routeNo": "AC-3",
    "requestedRouteNo": "ac3",
    "operator": "WBTC",
    "mode": "BUS",
    "stopCount": 5,
    "stops": [
      { "id": "uuid", "stopName": "Esplanade", "stopSequenceNo": 1, "depot": null, "normalizedName": "esplanade" }
    ]
  }
}
```

`routeNo` is the **canonical** number as stored, and `requestedRouteNo` is what the client sent. Requesting `ac3` returns `AC-3`, so a client that stores the response value gets an identifier the database actually contains. `stopSequenceNo` is `null` — never `0` — when the source had no sequence.

#### `GET /api/bus/routes/:routeNo/timetable`

| Query | Type | Default | Notes |
| --- | --- | --- | --- |
| `operator` | string | — | |
| `directionId` | int 0–9 | — | |
| `from` | `HH:MM` | — | Only trips departing at or after this time. Accepts hours past 24 (`25:10`). |
| `limit` | int 1–500 | `100` | |
| `offset` | int ≥ 0 | `0` | |

The route number is resolved through `route_aliases` as well as directly, so a route-stop number can be looked up by its timetable number and vice versa.

```json
{
  "success": true,
  "data": {
    "routeNo": "AC-3",
    "mode": "BUS",
    "resolvedRouteNos": ["AC-3"],
    "tripCount": 8,
    "trips": [
      { "routeNo": "AC-3", "tripNo": 1, "directionId": 0, "origin": "Esplanade", "destination": "Salt Lake", "departureTime": "06:30", "arrivalTime": "07:25" }
    ],
    "page": { "total": 8, "limit": 100, "offset": 0, "returned": 8, "hasMore": false }
  }
}
```

#### `GET /api/bus/search`

Same as `/api/search` with `mode=BUS` fixed. Query: `q` (required), `limit`.

#### `GET /api/bus/timetable-routes`

Every route number present in the timetable, with its trip count. Useful for discovering which route numbers the timetable actually covers.

#### `GET /api/bus/diagnostics`

Coverage and import audit, for verifying an import landed. Current values on the supplied data:

```json
{
  "routeStopRows": 1223,
  "distinctRouteNos": 47,
  "timetableRows": 3130,
  "timetableRouteNos": 67,
  "duplicateTripKeys": 72,
  "routesWithoutTimetable": ["... 45 route numbers ..."],
  "timetableRoutesWithoutStops": ["... 65 route numbers ..."],
  "configuredAliases": [],
  "importRuns": [
    {
      "sourceFile": "wbtc_bus_routes.csv",
      "rowsRead": 1224,
      "rowsInserted": 1223,
      "rowsRejected": 1,
      "startedAt": "...",
      "notes": [
        "64 row(s) had an empty depot and were stored as NULL",
        "WARNING: 1 route number(s) in the source have no usable row and will NOT appear in the API: AC-2 (every one of their rows was rejected)"
      ],
      "rejections": [
        { "row": 1198, "reason": "stop_sequence_no must be an integer greater than 0 (bus)", "value": "" }
      ]
    }
  ]
}
```

`routesWithoutTimetable` (45) and `timetableRouteNos` (67) versus `distinctRouteNos` (47) are the same fact from three directions: only 2 bus route numbers have a usable timetable. `importRuns` is capped at the 10 most recent and keeps the importer's own `notes` and `rejections` verbatim, so the audit trail is the importer's own account rather than a summary written after the fact.

### Metro

Metro is a real, implemented mode. The four Metro tables are supplied and read-only, and every endpoint below reads them as-is. A Metro "route" is a **line** (`BLUE`, `GREEN`, `ORANGE`, `PURPLE`, `YELLOW`, `PINK`), identified by its line code rather than a route number.

#### `GET /api/metro/status`

Implemented flag and the four table names with their purpose, stating that they are read-only.

#### `GET /api/metro/routes`

| Query | Type | Default |
| --- | --- | --- |
| `q` | string (partial line code or name) | — |
| `sort` | `line` \| `stop_count` \| `trip_count` | `line` |
| `order` | `asc` \| `desc` | `asc` |
| `limit` | int 1–500 | `50` |
| `offset` | int ≥ 0 | `0` |

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "routeId": "BLUE",
        "routeNo": "BLUE",
        "mode": "METRO",
        "operator": "Metro Railway",
        "name": "Blue Line",
        "stopCount": 27,
        "firstStop": "Kavi Subhash",
        "lastStop": "New Garia",
        "serviceDays": ["WEEKDAY", "SATURDAY", "SUNDAY"],
        "stationsWithTimetable": 26,
        "hasTimetable": true,
        "coverageNote": null
      }
    ],
    "page": { "total": 6, "limit": 50, "offset": 0, "returned": 6, "hasMore": false }
  }
}
```

`hasTimetable` is `false` for `PINK`, which has stations but no supplied timetable. `stationsWithTimetable` is per-line, so a line can be `hasTimetable: true` while some of its stations still only exist on the supplied map.

#### `GET /api/metro/routes/:routeId`

One line with its ordered stations, plus `orderings` — the number of distinct station orderings recorded. Metro lines are supplied in one direction only, so this is `1`; it is surfaced so a client can see that the order is the supplied order, not an independently verified timetable order.

#### `GET /api/metro/routes/:line/trips`

Real scheduled trips for a line.

| Query | Type | Default |
| --- | --- | --- |
| `line` | line code | *from the path* |
| `serviceDay` | `WEEKDAY` \| `SATURDAY` \| `SUNDAY` | — |
| `direction` | `UP` \| `DOWN` | — |
| `from` | `HH:MM` — only departures at or after this time | — |
| `limit` | int 1–500 | `100` |
| `offset` | int ≥ 0 | `0` |

Registered before `/metro/routes/:routeId` so that the literal path segment `trips` can never be read as a line code.

#### `GET /api/metro/stations`

| Query | Type | Default |
| --- | --- | --- |
| `line` | line code | — |
| `q` | string (partial station name) | — |
| `limit` | int 1–500 | `100` |
| `offset` | int ≥ 0 | `0` |

Each result carries `lines` — every line serving that station. More than one entry means an interchange.

#### `GET /api/metro/stations/:stationId`

One station, with the same `lines` array.

#### `GET /api/metro/stations/:stationId/timetable`

Real printed departure times for that station, across every line serving it. Query: `serviceDay`, `direction`, `from`, `limit`, `offset`. Where the supplied data has no time for a station, the response says so in a `note` field rather than returning an empty list that reads like a bug.

#### `GET /api/metro/search`

Same as `/api/search` with `mode=METRO` fixed.

#### `GET /api/metro/diagnostics`

Table list, row counts, per-line coverage (stations, timed stations, map-only stations, trips, service days, verbatim `coverageNote`), measured per-hop statistics, interchange stations, and the coverage caveats as `notes`. This is the endpoint that states the limits of the supplied data outright; see [Metro data limits](#metro-data-limits).

### Tram (withdrawn)

Tram is no longer served. Every path under `/api/tram/*` returns:

```json
{
  "success": false,
  "error": { "code": "TRAM_SERVICE_WITHDRAWN", "statusCode": 410, "message": "..." }
}
```

The `TRAM` mode is no longer accepted by `/api/search` or `/api/journey`. The legacy `tram_route_stops` table and its rows are left in the database untouched, as is migration `003`, so a rollback is always possible. Nothing in this project reads them.

### Journey planning

#### `POST /api/journey`

```bash
curl -X POST http://localhost:3000/api/journey \
  -H "content-type: application/json" \
  -d '{
    "source": "Esplanade",
    "destination": "Howrah Bridge",
    "mode": "ALL",
    "strategy": "MIN_TIME",
    "departureTime": "08:00",
    "timetableAware": true
  }'
```

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `source` | string 1–120 | *required* | Free text; resolved fuzzily. |
| `destination` | string 1–120 | *required* | Must differ from `source`. |
| `mode` | `ALL` \| `BUS` \| `METRO` \| `FERRY` | `ALL` | `TRAM` is rejected; it has been withdrawn. |
| `strategy` | `MIN_TIME` \| `MIN_INTERCHANGE` | `MIN_TIME` | |
| `departureTime` | ISO-8601 or `HH:MM` | now | |
| `timetableAware` | boolean | `true` | Use real timetable rows for bus and metro legs when available. |

```json
{
  "success": true,
  "data": {
    "source": "Kavi Subhash",
    "destination": "Gariahat",
    "totalTimeMinutes": 63,
    "interchangeCount": 1,
    "modesUsed": ["METRO", "BUS"],
    "timetableMatched": true,
    "segments": [
      { "mode": "METRO", "routeNo": "BLUE", "from": "Kavi Subhash", "to": "Park Street", "departureTime": "08:12", "arrivalTime": "08:26", "estimatedMinutes": 14, "timingConfidence": "SCALED" },
      { "mode": "WALK", "from": "Park Street", "to": "Park Street Metro", "estimatedMinutes": 5, "timingConfidence": "ESTIMATED" },
      { "mode": "BUS", "routeNo": "C-8", "from": "Park Street", "to": "Gariahat", "estimatedMinutes": 12, "timingConfidence": "SCHEDULED" }
    ],
    "warnings": ["..."]
  }
}
```

`totalDistanceKm` is **omitted entirely** unless real coordinates exist, and no coordinates exist in this data set.

Metro ride segments additionally carry `tripId`, `serviceDay` and `direction`, identifying the specific run that was priced. A Metro run is keyed on `(line, tripId, serviceDay, direction)`, not on `tripId` alone — `trip_id` is not unique in the supplied data.

#### Segment modes

| Mode | Meaning |
| --- | --- |
| `BUS` / `METRO` | A ride. `routeNo`, `operator` and the `stops` passed through are present. |
| `WALK` | Moving between two **different** stops. Backed by a real transfer edge, so `estimatedMinutes` is the transfer time, and `distanceKm` appears if the pair had coordinates. |
| `TRANSFER` | Changing vehicle at the **same** stop. `from` and `to` are identical, and `estimatedMinutes` is `MIN_INTERCHANGE_MINUTES` (default 5) — a planning allowance, always `ESTIMATED`. |

The distinction matters. Changing from one bus to another at the same stop is still a change of vehicle, so it is an interchange and it costs time; but no walking between distinct places is implied, so it is not a `WALK` leg. A `WALK` leg already includes its own waiting, so no `TRANSFER` leg is added on top of it.

`interchangeCount` is the number of boundaries between ride legs — `rides − 1` — regardless of whether a `WALK` or a `TRANSFER` sits between them. Counting only walks would report a two-bus journey as zero interchanges and time it as though both buses were one.

Each segment carries `timingConfidence`:

| Value | Meaning |
| --- | --- |
| `EXACT` | Departure/arrival times taken directly from a matching timetable trip. For Metro, both the printed boarding departure and the printed alighting arrival exist. |
| `SCALED` | Derived from real timetable rows for the run, scaled to the portion of the line actually travelled. For Metro, the run's real duration is projected across the boarded hops, starting from the printed boarding time when one exists. |
| `ESTIMATED` | Static estimate — used for every transfer walk, every changeover, any bus route with no timetable coverage, and Metro lines with no supplied timetable (currently `PINK`). |

When no connected journey exists, the endpoint returns `200` with an empty `segments` array and a `warnings` entry explaining why, rather than a `404`.

### Graph introspection

#### `GET /api/graph/stats`

Builds the graph if the cache is cold, then reports node/edge/route counts, nodes by mode, routes on real vs estimated timings, excluded placeholder stops, transfer-detection statistics, and the active transfer configuration (including `minInterchangeMinutes`).

`crossOperatorTimings` is the field worth reading on this data set. It lists every route whose real duration was adopted across an operator boundary:

```json
"crossOperatorTimings": ["WBTC:AC-3 -> CSTC", "WBTC:AC-4 -> CSTC"]
```

The route-stop file has no operator column, so its rows are written as `WBTC`, while the timetable file carries its own operator, `CSTC`. A strict `(operator, route_no)` join therefore matches nothing at all. The builder matches on the route number instead, but **only when exactly one operator claims that number**, so two operators' durations are never averaged together — and every cross-operator match is reported here rather than applied quietly.

#### `GET /api/graph/transfers`

Every detected transfer with the reason it was detected and the resulting walk time. `?limit=` (1–1000, default 100).

```json
{
  "success": true,
  "data": {
    "total": 24,
    "returned": 24,
    "reasons": { "EXACT_NAME_MATCH": 24 },
    "transfers": [
      {
        "from": { "nodeId": "bus:wbtc:esplanade", "name": "Esplanade", "mode": "BUS", "operator": "WBTC" },
        "to": { "nodeId": "metro:metro-railway:esplanade", "name": "Esplanade", "mode": "METRO", "operator": "Metro Railway" },
        "reason": "EXACT_NAME_MATCH",
        "nameSimilarity": 1,
        "distanceMeters": null,
        "transferTimeMinutes": 5
      }
    ]
  }
}
```

`distanceMeters` is `null`, never estimated, because no bus or metro record carries coordinates. Every transfer in this data set is therefore a name match: two places are linked when their normalised names are equal or sufficiently similar, not because they were measured to be close. That is a real limitation, and it is why a transfer walk is always `ESTIMATED`.

### Ferry (not configured)

| Endpoint | Result |
| --- | --- |
| `GET /api/ferry/status` | `501` |
| `GET /api/ferry/routes` | `501` |
| `GET /api/ferry/routes/:routeNo` | `501` |
| `GET /api/ferry/routes/:routeNo/stops` | `501` |
| `GET /api/ferry/routes/:routeNo/timetable` | `501` |

No ferry CSV was supplied, and the specification forbids inventing the schema.

### Admin

Disabled unless `ADMIN_KEY` is set. With no key they return `503 ADMIN_AUTH_REQUIRED` — failing closed, not open.

Send the key as `x-admin-key`.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/admin/status` | Open. Reports whether admin routes are enabled. |
| `POST /api/admin/graph/refresh?force=true` | Rebuild the cached transport graph after a data change. |
| `GET /api/admin/routes/aliases?mode=BUS` | List route-number mappings. |
| `POST /api/admin/routes/alias` | Create or update one mapping. |

```bash
curl -X POST http://localhost:3000/api/admin/graph/refresh?force=true \
  -H "x-admin-key: $ADMIN_KEY"
```

```bash
curl -X POST http://localhost:3000/api/admin/routes/alias \
  -H "content-type: application/json" -H "x-admin-key: $ADMIN_KEY" \
  -d '{"mode":"BUS","sourceRouteNo":"1A","targetRouteNo":"AC-1","note":"verified by hand"}'
```

Route numbers in the bus route-stop file (`WBTC`, e.g. `1A`) and in the timetable file (`CSTC`, e.g. `AC-3`) are different namespaces. They only overlap on `AC-3` and `AC-4`, so the rest of the mapping has to be supplied by a human through this endpoint rather than guessed.

---

## Error codes

| Code | HTTP | Meaning |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | Request failed validation; `details` lists the fields. |
| `INVALID_QUERY` | 400 | A query parameter is well-formed but unusable, e.g. a bad `from` time. |
| `INVALID_JSON` | 400 | The request body was not valid JSON. |
| `NOT_FOUND` | 404 | No such route. |
| `ROUTE_NOT_FOUND` | 404 | No such route number. |
| `STATION_NOT_FOUND` / `STOP_NOT_FOUND` / `TRIP_NOT_FOUND` | 404 | Journey endpoint or stop could not be resolved. |
| `NO_ROUTE_FOUND` | 422 | The request was valid but no journey exists. |
| `RATE_LIMITED` | 429 | Too many requests. |
| `TRAM_SERVICE_WITHDRAWN` | 410 | Any `/api/tram/*` path. The mode has been withdrawn. |
| `FERRY_NOT_CONFIGURED` | 501 | Mode reserved but has no data. |
| `DATABASE_NOT_CONFIGURED` | 503 | No `DATABASE_URL`. |
| `DATABASE_UNAVAILABLE` | 503 | The database is unreachable; the driver message is in `details`. |
| `ADMIN_AUTH_REQUIRED` | 503 | Admin routes are disabled or the key is wrong (401). |
| `GRAPH_UNAVAILABLE` | 503 | A rebuild was throttled; `details.retryAfterSeconds` says when to retry. |
| `INTERNAL_ERROR` | 500 | Unexpected failure. The real message is hidden in production. |

---

## How the planner works

1. **Graph build.** A stop becomes a node keyed by `(mode, operator, normalised name)`. Consecutive stops on a route become ride edges, bidirectional because the route-stop files carry no direction column. Placeholder stop names are excluded from the graph but stay in the database.
2. **Timetable-derived timings.** Where a bus route has real timetable rows, the average observed trip duration sets its per-hop time (`TIMETABLE_AVERAGE`). Otherwise the mode's median is used (`MODE_DEFAULT`), and only if no route in the mode has timetable data at all does it fall back to a configured constant (`STATIC_FALLBACK`). A route is matched to its durations on the route number, and only when exactly one operator claims that number — the route-stop and timetable files disagree about the operator, so a strict `(operator, route_no)` join matches nothing. See [Timetable coverage](#timetable-coverage-is-2-routes-out-of-66).
3. **Metro per-hop times are measured, not averaged.** For Metro, per-hop travel time comes from timing consecutive printed checkpoints *within the same run*, not from `AVG(duration_minutes) / hop_count`. That shortcut is wrong for this data: most runs are full-length but some are short-turns, so dividing a full-line hop count by an average duration badly understates the real hop time — it yields 1.2 min/hop on the Yellow Line and 1.6 on the Purple Line, both far too fast for a metro. Measuring between adjacent printed times gives 2.8–4.0 min/hop across the five timetabled lines. The result is fed in as a per-hop seed, so those lines are also `TIMETABLE_AVERAGE`.
4. **Metro per-run times use the real timetable where it exists.** A run is identified by `(line, trip_id, service_day, direction)` because `trip_id` is not unique. If the timetable prints both a departure at the boarding station and an arrival at the alighting station, the segment is `EXACT`. If only the run's duration is known, the segment is `SCALED` by projecting that duration across the hops actually travelled — starting from the printed boarding time when there is one, and otherwise from the run's own departure at its origin. Getting that origin distinction wrong would shift a real printed time, so it is covered by a regression test.
5. **Transfers.** With coordinates, any two stops within `MAX_TRANSFER_DISTANCE_METERS` are linked (`COORDINATE_PROXIMITY`). Without them, exact normalised name matches are linked (`EXACT_NAME_MATCH`), plus high-similarity matches at or above `TRANSFER_NAME_SIMILARITY_THRESHOLD` (`HIGH_SIMILARITY`). Walk time is derived from real distance when available, otherwise `DEFAULT_TRANSFER_MINUTES`. A change of vehicle at the *same* stop has no transfer edge at all — it is a `TRANSFER` segment costing `MIN_INTERCHANGE_MINUTES` instead.
6. **Search.** A* over the cached graph, with `MIN_TIME` applying a small per-interchange penalty and `MIN_INTERCHANGE` applying a large one, which makes "fewest changes, then fastest" a lexicographic optimisation. The search state is a node *plus the line it was reached on*, because changing lines always costs an interchange — even when no `TRANSFER` edge is involved, since the passenger still gets off one vehicle and waits for the next. Keying on the node alone let the search take a marginally faster line for a single hop and then be billed for the change afterwards: on the Blue Line, where the Purple Line is 2.84 min/hop against Blue's 3.37, that turned an 81-minute ride into 90 across two interchanges nobody needed. The search now prices the change itself, so a free line-hop is no longer available.
7. **Caching.** The graph is built once and cached in process memory, not rebuilt per request. After an import, call `POST /api/admin/graph/refresh`.

The planner itself (`src/graph/`) knows nothing about HTTP — it takes a graph and two node ids. It can be moved into a dedicated compute service unchanged.

---

## Data quality decisions

Nothing below is guessed or silently corrected.

| Finding | Decision |
| --- | --- |
| 1 bus row with an empty `stop_sequence_no` | Rejected and reported. A bus stop without a sequence is a data error, not a `NULL` to preserve. This is the only row of route `AC-2`, so that route is not served; the importer reports vanished routes explicitly. |
| 64 bus rows with an empty `depot` | Stored as SQL `NULL`. |
| 6 tram rows with an empty `stop_sequence_no` | Historical. Stored as SQL `NULL`, never `0`. The table is no longer read. |
| 72 repeated `(route_no, trip_no, direction_id)` keys | All source rows preserved. The specification's DDL does not constrain that triple, and dropping rows would lose real services. |
| `(no stop data captured)` placeholders (1 bus, 6 tram) | Stored unchanged, excluded from the graph, search, and transfers. Reported by `/api/bus/diagnostics` and `/api/graph/stats`. |
| Route-stop vs timetable route numbers | Bridged via `route_aliases`. Only `AC-3` and `AC-4` overlap; nothing else is assumed. |
| Route-stop operator (`WBTC`) vs timetable operator (`CSTC`) | Durations joined on the route number alone, and only when unambiguous; every such match is listed in `graph.stats.crossOperatorTimings`. |
| `wbtc_tram_routes.csv` extra `id` column | Detected and dropped. It is a source-file artifact, not transport data, and is not in the specification's column list. |
| No coordinates anywhere in bus or metro data | `totalDistanceKm` and `distanceMeters` are `null`/omitted, never estimated. |
| No direction column in route-stop files | Ride edges are bidirectional. |
| Tram timetable never supplied | Moot — the Tram service has been withdrawn. |

### Metro data limits

Metro is implemented, but the supplied data is thin, and `/api/metro/diagnostics` reports all of this in numbers. Stating it here so the API's output is not mistaken for broader coverage than it has:

- **6 lines, 80 line/station entries, 1,720 trips, 5,849 checkpoints.**
- **The Pink Line has 10 stations and no timetable at all.** Its journey times are `ESTIMATED`, and responses say so rather than returning a confident wrong number.
- **Only 16 of the 80 line/station entries — 15 distinct station names — have a printed time.** Most Metro stations exist only on the supplied map.
- Timetables were supplied for 5 lines. Where a run has both a printed boarding departure and a printed alighting arrival the result is `EXACT`; where only the run's duration is known it is `SCALED` across the travelled hops; otherwise `ESTIMATED`.
- Metro lines are recorded in **one direction only**, so `direction` is present on runs and trips but the supplied station order is not an independently verified ordering. `orderings: 1` on a line says exactly that.
- `metro_timetable_checkpoints.station_sequence` is an ordinal within a run, **not** a position on the line. Line position comes from `metro_stations.station_sequence`. Using the checkpoint column as a line position silently corrupts every interpolation.
- Because no Metro record carries coordinates, a bus↔metro interchange is only ever a name match. A place named the same in both networks is treated as a transfer, which is usually right in Kolkata and cannot be verified from this data.

### Timetable coverage is 2 routes out of 66

This is the most important caveat in the project, and `/api/graph/stats` states it in numbers:

```
routesWithRealTimings  : 2      (AC-3, AC-4)
routesOnStaticEstimate : 64
```

The timetable file describes 67 route numbers; the route-stop file describes 47 bus route numbers; **only `AC-3` and `AC-4` appear in both.** So 64 of the 66 graph routes are priced from the median hop time of the routes that do have real data, not from measurements of themselves. Journey legs on those routes are correctly labelled `ESTIMATED`, and `timetableMatched` is `false`.

The two namespaces cannot be reconciled from the data available. `route_aliases` is the intended bridge and is empty; filling it would mean asserting that e.g. timetable route `1` is the same service as route-stop `C-8`, and nothing in the supplied files supports that. The gap is reported rather than papered over.

---

## Testing

```bash
npm run verify
```

`verify` runs the source typecheck, the test typecheck, the test suite, and the build. `npm test` alone runs just the tests.

Covers the pure logic (time parsing across midnight, name normalisation and fuzzy matching, A* pathfinding including mode filters, the `MIN_INTERCHANGE` strategy) and the HTTP contract via `app.inject()`.

Test groups exist specifically to stop regressions found by running the API against the real data, all of which had produced plausible wrong answers rather than errors:

- `test/journey.segments.test.ts` — that a change of bus at the same stop counts as one interchange and adds changeover time, that a `WALK` leg is not double-counted with a `TRANSFER` leg, and that a multi-hop single route stays one segment.
- the same file's `createRouteStatsLookup` group — that route durations are matched across the `WBTC`/`CSTC` operator boundary, and **refused** when two operators claim the same route number, so durations are never averaged.
- `test/metro.timing.test.ts` — that a printed boarding time is used as-is rather than being shifted by the run's origin offset, that a printed boarding/alighting pair is `EXACT`, that a run is scaled by the hops actually travelled, that the printed time is preferred over an interpolated one, that waiting for the next run is applied, and that a line with no timetable falls back to a static estimate.
- `test/pathfinder.test.ts` — that a slightly faster parallel line is not bought for a single hop when that forces an interchange, that a genuinely required line change is still taken and counted as one, and that a bus-to-metro `TRANSFER` edge is charged once rather than twice. Found by planning a real Blue Line journey and getting 90 minutes across two interchanges for a trip the map shows as one direct ride.

The contract tests deliberately run with **no** `DATABASE_URL`. They assert the app boots, that `/api/health` is `200`, that data endpoints return `DATABASE_NOT_CONFIGURED` rather than crashing, that Ferry returns `501` and `/api/tram/*` returns `410`, that malformed input and malformed JSON produce the right error codes, and that admin routes fail closed. Live-data verification runs against a real Supabase project via `/api/bus/diagnostics` and `/api/metro/diagnostics`.

---

## Deploying to Vercel

`api/index.ts` is the serverless entry point. It builds the Fastify app once and caches it on `globalThis`, so warm invocations reuse the same app, the same transport graph, and the same Postgres pool.

Set these as Vercel environment variables:

```
DATABASE_URL   = postgresql://...pooler.supabase.com:5432/postgres
ADMIN_KEY      = <a long random string>
CORS_ORIGINS   = https://your-frontend.example
NODE_ENV       = production
TRUST_PROXY    = true
```

`vercel.json` routes `/api/*` to the function with a 1 GB memory limit and a 30 s duration. For a container host instead, `npm run build && npm start` works as-is.

---

## Project layout

```
src/
  app.ts                     Fastify factory: plugins, routes, 404 and error handlers
  server.ts                  Standalone HTTP entry point (npm run dev / start)
  config/       env.ts       Validated environment; the app boots without a database
                database.ts  Lazy pg pool, query helpers, transactions
  models/       bus.model.ts metro.model.ts
                request.schemas.ts  Zod validation + client-friendly error formatting
  types/        transport.ts  Shared domain types and the API envelope
  repositories/ bus | metro | ferry | base
  graph/        transport.graph.ts  Graph construction
                graph.node.ts / graph.edge.ts / pathfinder.ts / transfer.service.ts
  services/     bus | metro | search | journey | graph | modes
  controllers/  One per resource area; thin parse-delegate-respond
  routes/       One per resource area; registration only
                tram.routes.ts  retired: answers 410 for every /tram/* path
  scripts/      import-csv.ts and the per-file bus import entry points
  utils/        errors | response | normalize | geo | time
  db/           migrate.ts and migrations/*.sql
api/index.ts                 Vercel serverless entry point
public/index.html            Single-page frontend and API explorer
test/                        time | normalize | pathfinder | api.contract
                             journey.segments  regression tests for the two
                             live-data defects described above
                             metro.timing     Metro run-timing regression tests
```
# backtran

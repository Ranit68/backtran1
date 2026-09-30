-- 007: Metro station platform numbers
--
-- WHY THIS EXISTS
-- ---------------
-- `GET /api/routes/:routeNo/connections` answers "which platform do I wait on at
-- the interchange", which cannot be answered from a station name alone. Platform
-- numbering is per line at a station: at Esplanade the Blue and Green platforms
-- are numbered independently, so the same number means a different physical
-- platform on each line. That is why the primary lookup is
-- (station_code, line) and never the station name by itself.
--
-- The table and its 116 rows were uploaded directly to the database. This
-- migration records the shape in the repository so a fresh environment
-- reproduces it, and so the schema is reviewable. It is written to be safe
-- against a database that already has the table, because on the live database
-- CREATE TABLE would otherwise fail and abort the migration run.
--
-- NO FOREIGN KEY ON (station_code, line)
-- -------------------------------------
-- Four rows reference terminal stations that are not in `metro_stations`:
-- BLUE_KKGH_P1/P2 (Kalighat) and ORANGE_KKVS_P3/P4 (Kavi Subhash). They are
-- real platform records and are kept. A foreign key would refuse to load them
-- and would have to be deferred, which is worse than a query that reports the
-- unmatched rows honestly. The repository does not require them to match: it
-- left-joins, so an unmatched terminal row would still surface.
--
-- verification_status IS NOT COSMETIC
-- -----------------------------------
-- 6 rows are SOURCE_CONFLICT (all four Esplanade Blue/Green rows, plus Salt
-- Lake Sector V) and 74 are INFERRED_DIRECTION_PLATFORM, inferred from line
-- order rather than observed. A wrong platform number is worse than no number
-- because the rider trusts it, so the API returns the number together with this
-- status and adds a warning whenever any of them should not be taken at face
-- value. The column exists so that doubt travels with the data instead of being
-- resolved once and baked in.

CREATE TABLE IF NOT EXISTS metro_station_platforms (
  -- Stable key, e.g. 'BLUE_KESP_P1'. Text rather than a serial because the id
  -- is built from the line, station and platform and must survive re-imports.
  platform_id           text PRIMARY KEY,
  station_code          text NOT NULL,
  station_name          text NOT NULL,
  line                  text NOT NULL,
  -- Text, not integer: values such as '1A' and '2B' appear in signage, and
  -- coercing them to a number would quietly lose the suffix.
  platform_number       text NOT NULL,
  towards               text,
  -- 'UP', 'DOWN', or 'TERMINAL/ALIGHTING'. The last is not a boarding side and
  -- must not be presented as a platform to board from.
  direction             text,
  status                text,
  verification_status   text,
  source_id             text,
  source_note           text
);

-- The endpoint filters by line and a set of station codes, so the pair is the
-- hot path. Single-column indexes on station_code and line exist to match the
-- uploaded table, and verification_status supports counting doubt per line.
CREATE INDEX IF NOT EXISTS idx_metro_platforms_station_line
  ON metro_station_platforms (station_code, line);
CREATE INDEX IF NOT EXISTS idx_metro_platforms_station_code
  ON metro_station_platforms (station_code);
CREATE INDEX IF NOT EXISTS idx_metro_platforms_station_name
  ON metro_station_platforms (station_name);
CREATE INDEX IF NOT EXISTS idx_metro_platforms_line
  ON metro_station_platforms (line);
CREATE INDEX IF NOT EXISTS idx_metro_platforms_verification
  ON metro_station_platforms (verification_status);

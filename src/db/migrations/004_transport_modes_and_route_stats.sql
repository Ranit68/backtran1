-- 004: Transport mode lookup
--
-- A small, mode-agnostic lookup table so that later phases (Metro, Ferry) have
-- somewhere to register themselves without needing another migration. It
-- contains NO transport data -- only the four mode labels from spec section 10.
-- It is NOT a ferry schema: no ferry columns, no ferry route/stop/timetable
-- tables are invented, per spec sections 8 and 28.

CREATE TABLE transport_modes (
    mode        TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    enabled     BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO transport_modes (mode, display_name, enabled) VALUES
    ('METRO', 'Metro',  FALSE),
    ('BUS',   'Bus',    TRUE),
    ('TRAM',  'Tram',   TRUE),
    ('FERRY', 'Ferry',  FALSE)
ON CONFLICT (mode) DO UPDATE
SET display_name = EXCLUDED.display_name,
    enabled = EXCLUDED.enabled;

-- Per-route aggregate cache, populated by the importer.
-- avg_trip_minutes is DERIVED from bus_timetables (real arrival - departure
-- values). It is never invented. Routes with no usable timetable rows keep
-- NULL here and fall back to the configured per-mode speed estimate.
CREATE TABLE route_trip_stats (
    operator        TEXT NOT NULL,
    route_no        TEXT NOT NULL,
    mode            TEXT NOT NULL,
    sample_count    INTEGER NOT NULL DEFAULT 0,
    avg_trip_minutes DOUBLE PRECISION,
    min_trip_minutes DOUBLE PRECISION,
    max_trip_minutes DOUBLE PRECISION,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (operator, route_no)
);

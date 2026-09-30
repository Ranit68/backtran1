-- 006: Enable the FERRY transport mode
--
-- WHY THIS EXISTS
-- ---------------
-- Migration 004 created `transport_modes` as a forward-looking registry and
-- seeded FERRY with enabled = FALSE, back when ferry was a reserved adapter with
-- no data behind it.
--
-- The ferry data set is now loaded and the mode is live: 8 operational routes,
-- 14 ghats, 23 directed legs, plus schedules, fares and sources. The graph loads
-- ferry as an optional provider whose failure is isolated to ferry alone, and
-- `/api/ferry/*` is served for real rather than answering 501.
--
-- TRAM is already TRUE in 004: both tram routes are operational, and the
-- historical 410 "TRAM_SERVICE_WITHDRAWN" response was wrong for this data set.
--
-- This flips one flag. It deliberately adds no ferry schema: the tables already
-- exist from the data import, and this migration must not be the thing that
-- creates them, so that it stays safe to run against a database that already has
-- them and against one that does not.

UPDATE transport_modes
SET enabled = TRUE
WHERE mode = 'FERRY';

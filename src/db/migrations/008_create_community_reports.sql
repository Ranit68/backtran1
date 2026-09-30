-- 008: Route-scoped community reports
--
-- WHY THIS EXISTS
-- ---------------
-- Riders tell each other what is happening on their own route: a bus stuck in
-- water, a ferry cancelled, a platform closed for repair. The value is entirely
-- in the scoping. A report about flooding on the Blue Line is only useful to
-- someone about to take the Blue Line, and is noise to everyone else, so every
-- post is attached to exactly one route and a feed only ever shows that route.
--
-- SCOPE IS A CANONICAL KEY, NOT A FREE-TEXT LABEL
-- -----------------------------------------------
-- scope_mode plus scope_key is the identity, where scope_key is the route as the
-- data set knows it: 'BLUE' for a metro line, 'NB-1' for a bus, 'F003' for a
-- ferry, 'TRAM5' for a tram. scope_label is display only and is never used to
-- group. If grouping were done on the label, a post on "Blue Line" and one on
-- "North-South / Blue Line" would land in two different communities that are
-- obviously the same place.
--
-- 24 HOUR LIFETIME, STORED EXPLICITLY
-- -----------------------------------
-- expires_at is written at insert time as created_at plus 24 hours rather than
-- being computed as NOW() minus 24 hours on every read. Two reasons: the read
-- path becomes a plain indexed comparison instead of arithmetic on a column, and
-- the lifetime is visible in the stored row, so a post cannot be kept alive by
-- anything but its own age. Reading always filters on expires_at > NOW(), so a
-- post disappears the moment it is due even if no cleanup job has run.
--
-- There is no scheduler in this service, so deletion is opportunistic: a
-- repository call may sweep expired rows. That is a space optimisation only, not
-- the mechanism that hides a post. Correctness does not depend on the sweep ever
-- running, which is the property that matters, because a cleanup job that fails
-- silently must never become the reason an expired post stays visible.
--
-- NO AUTHOR COLUMN
-- ---------------
-- This service has no accounts, no sessions and no login of any kind, so a post
-- cannot be attributed to a verified person. Inventing an author field would
-- imply an identity the backend cannot check. Posts are anonymous by design and
-- the API says so, rather than storing a name that anyone can type.
--
-- ABUSE
-- -----
-- message is TEXT and length is enforced in the request schema, not here, so
-- that the limit is visible to the client in the validation error instead of
-- arriving as an opaque database error. rate_limited_at exists so the write path
-- can record and observe throttling without a second table.

CREATE TABLE IF NOT EXISTS community_reports (
  -- Random rather than sequential: an incrementing id would let a caller walk
  -- the whole table by incrementing it. Posts are public, but they are also
  -- unmoderated, and enumeration is how spam tooling finds a target.
  report_id     TEXT PRIMARY KEY,
  scope_mode    TEXT NOT NULL,
  scope_key     TEXT NOT NULL,
  scope_label   TEXT NOT NULL,
  message       TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Evaluated per row at insert, so every post carries its own expiry. A
  -- default of NOW() is correct here: it is fixed when the row is written,
  -- unlike a view expression that would slide forward on every read.
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  -- Kept for observability of the write path, not used to gate writes: the
  -- per-route limiter is in memory and resets with the process.
  rate_limited_at TIMESTAMPTZ,

  CONSTRAINT community_reports_scope_mode_check
    CHECK (scope_mode IN ('BUS', 'METRO', 'FERRY', 'TRAM')),

  -- Belt and braces behind the request schema. A 5000 character post is not
  -- valid input at any layer, and the database is the last place that can say so
  -- without trusting the caller.
  CONSTRAINT community_reports_message_length_check
    CHECK (char_length(message) BETWEEN 1 AND 500),

  -- A post must not outlive the rule that created it, whatever the clock says.
  CONSTRAINT community_reports_expiry_after_creation_check
    CHECK (expires_at > created_at)
);

-- The feed query: one route, newest first, already past expiry. This is the
-- only hot path, and the leading two columns are the equality part of it.
CREATE INDEX IF NOT EXISTS idx_community_reports_scope
  ON community_reports (scope_mode, scope_key, created_at DESC);

-- Supports the opportunistic expiry sweep without scanning live posts.
CREATE INDEX IF NOT EXISTS idx_community_reports_expires
  ON community_reports (expires_at);

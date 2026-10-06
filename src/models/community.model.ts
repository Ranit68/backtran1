/**
 * Community report types.
 *
 * A report is a short piece of text a rider leaves about the route they are
 * about to travel. The scoping is the whole point: a post belongs to exactly one
 * route, and a feed shows only that route's posts -- or, with no route in the
 * path, every live post in the whole mode.
 *
 * There is no author anywhere in this shape, and that is deliberate rather than
 * unfinished. The service has no accounts, so a name field could only ever be
 * text the poster typed, and calling it an author would imply an identity the
 * backend cannot verify. `anonymous` states that in the response instead.
 */

export type CommunityMode = "BUS" | "METRO" | "FERRY" | "TRAM";

/**
 * Sentinel key for a whole-mode feed: `scope_key` is `NOT NULL`, so rather than
 * making the column nullable the whole mode reuses one row identity. A mode-wide
 * post is stored under this key, and a mode-wide read ignores the key column
 * entirely, which is what makes a feed of `/api/community/BUS` show every live
 * bus report no matter which route was on it.
 */
export const MODE_WIDE_KEY = "*";

/** How long a post stays visible, in hours. */
export const REPORT_TTL_HOURS = 24;

/**
 * Hard cap on a post.
 *
 * Enforced in the request schema as well as the table constraint, so the client
 * gets a field-level validation error naming the limit instead of an opaque
 * database failure.
 */
export const REPORT_MESSAGE_MAX_LENGTH = 500;

/** A route as the data set knows it, which is what a feed is grouped by. */
export interface RouteScope {
  mode: CommunityMode;
  /** Canonical identity, e.g. 'BLUE', 'NB-1', 'F003', 'TRAM5'. */
  key: string;
  /** Human-readable name, for display only. Never used to group posts. */
  label: string;
}

/** Display label for a whole-mode feed, used where the route's name would be. */
const MODE_NETWORK_LABELS: Record<CommunityMode, string> = {
  BUS: "Bus network",
  METRO: "Metro network",
  FERRY: "Ferry network",
  TRAM: "Tram network",
};

/**
 * The scope of "/community/:mode" with no route in the path: the whole mode,
 * not one route. Keyed with {@link MODE_WIDE_KEY} because `scope_key` is
 * `NOT NULL`, and reads for it filter on mode alone so a post filed under any
 * route stays visible in the mode's feed.
 */
export function modeScope(mode: CommunityMode): RouteScope {
  return {
    mode,
    key: MODE_WIDE_KEY,
    label: MODE_NETWORK_LABELS[mode],
  };
}

export interface CommunityReport {
  reportId: string;
  mode: CommunityMode;
  routeKey: string;
  routeLabel: string;
  message: string;
  /** ISO 8601, so a client does not have to guess a timezone. */
  createdAt: string;
  /** ISO 8601. Equal to createdAt + 24 hours. */
  expiresAt: string;
  /** Always true: this service has no accounts. */
  anonymous: true;
  /**
   * Whole hours until the post disappears, floored at 0.
   * Lets a client show "expires in 5h" without reimplementing the TTL, which
   * would let the two drift apart.
   */
  expiresInHours: number;
}

export interface CommunityFeed {
  scope: RouteScope;
  reports: CommunityReport[];
  /** How many live posts this route has, which may exceed the returned page. */
  totalActive: number;
  /** Echoed back, so a caller paging through can ask for the next window. */
  offset: number;
  /**
   * True when more live posts exist after this window.
   *
   * Computed against `offset + reports.length`, not against the page length,
   * because a caller that has already read 100 posts and asks from offset 100
   * has not run out of posts just because its window was full.
   */
  hasMore: boolean;
  ttlHours: number;
  messageMaxLength: number;
  /** Restated on every feed so a client cannot hardcode the rule. */
  posting: {
    anonymous: true;
    requiresAccount: false;
  };
}

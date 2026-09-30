/**
 * Community report types.
 *
 * A report is a short piece of text a rider leaves about the route they are
 * about to travel. The scoping is the whole point: a post belongs to exactly one
 * route, and a feed shows only that route's posts.
 *
 * There is no author anywhere in this shape, and that is deliberate rather than
 * unfinished. The service has no accounts, so a name field could only ever be
 * text the poster typed, and calling it an author would imply an identity the
 * backend cannot verify. `anonymous` states that in the response instead.
 */

export type CommunityMode = "BUS" | "METRO" | "FERRY" | "TRAM";

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
  /** True when totalActive is greater than reports.length. */
  hasMore: boolean;
  ttlHours: number;
  messageMaxLength: number;
  /** Restated on every feed so a client cannot hardcode the rule. */
  posting: {
    anonymous: true;
    requiresAccount: false;
  };
}

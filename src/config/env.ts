import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv();

/**
 * Environment schema.
 *
 * The application is designed to BOOT WITHOUT a database. This is deliberate:
 * it lets the API be type-checked, built, started and smoke-tested before any
 * Supabase project exists, and it keeps Vercel preview deployments from
 * hard-failing when a secret is missing. When DATABASE_URL is absent the
 * repositories short-circuit and endpoints return a documented
 * `DATABASE_NOT_CONFIGURED` error instead of crashing the process.
 */
const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((value) => {
    if (typeof value === "boolean") return value;
    return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
  });

/**
 * An empty or whitespace-only value counts as ABSENT, not as an invalid one.
 *
 * `DATABASE_URL=` on its own line is how most people comment a variable out in
 * .env, and z.string().min(1) would reject it as a validation error, stopping
 * the process with a confusing message. Absent is the intended meaning, and it
 * is a state this application supports by design.
 */
const emptyToUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const optionalText = z.preprocess(emptyToUndefined, z.string().min(1).optional());
const optionalUrl = z.preprocess(emptyToUndefined, z.string().url().optional());

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),
  HOST: z.string().default("0.0.0.0"),

  /** Supabase / Postgres connection string. Optional at boot (see note above). */
  DATABASE_URL: optionalText,
  SUPABASE_URL: optionalUrl,
  SUPABASE_ANON_KEY: optionalText,

  /** Comma-separated list, or "*" to allow any origin. */
  CORS_ORIGINS: z.string().default("*"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  TRUST_PROXY: booleanish.default(false),

  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_WINDOW: z.string().default("1 minute"),

  /** Shared secret for POST /api/admin/graph/refresh. When unset the route 503s. */
  ADMIN_KEY: optionalText,

  /**
   * Hard ceiling used by TransferService (spec section 12).
   * Kept in env so it can be tuned without a code change, but the spec value
   * of 300 is the default and is the only value used unless overridden.
   */
  MAX_TRANSFER_DISTANCE_METERS: z.coerce.number().positive().default(300),
  /**
   * Default walk/transfer penalty in minutes, used only when the two stops in
   * a transfer pair have no coordinates. Static estimate per spec section 22.
   */
  DEFAULT_TRANSFER_MINUTES: z.coerce.number().positive().default(5),
  /**
   * Minimum normalised-name similarity for two stops of DIFFERENT operators or
   * modes to be considered the same interchange when coordinates are missing.
   * Prevents linking every similarly named stop (spec section 12).
   */
  TRANSFER_NAME_SIMILARITY_THRESHOLD: z.coerce.number().min(0).max(1).default(0.9),

  /**
   * Static planning allowance for changing vehicle at a stop, in minutes:
   * alighting, crossing to the other platform and waiting for the next service.
   *
   * A route change at the SAME stop is still a change of vehicle, so it costs
   * this much; without it a two-bus journey would be timed as if the two buses
   * were one. It is an allowance, not a measurement, and every such segment is
   * reported with timingConfidence ESTIMATED.
   */
  MIN_INTERCHANGE_MINUTES: z.coerce.number().min(0).default(5),

  /** Absolute or relative path to the folder holding the source CSV files. */
  DATA_DIR: z.string().default("data"),

  /** Operator written for route-stop rows whose source CSV has no operator column. */
  DEFAULT_ROUTE_STOP_OPERATOR: z.string().default("WBTC"),

  /** Seconds before a cached transport graph is considered stale. */
  GRAPH_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  /** Hard ceiling on graph rebuilds per process, to protect the database. */
  GRAPH_REBUILD_MIN_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(30),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
  // Fail loudly and immediately: a misconfigured boolean must not silently
  // disable rate limiting in production.
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

const raw = parsed.data;

export const env = {
  ...raw,
  isProduction: raw.NODE_ENV === "production",
  isTest: raw.NODE_ENV === "test",
  hasDatabase: Boolean(raw.DATABASE_URL),
  corsOrigins:
    raw.CORS_ORIGINS.trim() === "*"
      ? ("*" as const)
      : raw.CORS_ORIGINS.split(",")
          .map((origin) => origin.trim())
          .filter(Boolean),
} as const;

export type Env = typeof env;

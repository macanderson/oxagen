import { z } from "zod";

// Apps subset the global schema via `requireEnv` and re-validate at boot.
// Spec §11: missing required vars fail closed, no silent defaults beyond
// what's marked optional here.
export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  DATABASE_URL: z.string().url(),

  CLICKHOUSE_URL: z.string().url(),
  CLICKHOUSE_USERNAME: z.string().min(1),
  CLICKHOUSE_PASSWORD: z.string().default(""),
  CLICKHOUSE_DATABASE: z.string().default("oxagen"),

  NEO4J_URI: z.string().min(1),
  NEO4J_USERNAME: z.string().min(1),
  NEO4J_PASSWORD: z.string().min(1),
  NEO4J_DATABASE: z.string().default("neo4j"),

  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url(),

  // OAuth providers are each split into two distinct clients (same provider
  // app/project) so a broad data-scope client never gates plain login:
  //  - LOGIN: minimal sign-in scopes — social sign-in (in use).
  //  - DATA:  data-source scopes — reserved for the future data connection.
  // Google → google-workspace (Drive/Sheets/Gmail/…); GitHub → repo ingestion.
  GOOGLE_LOGIN_CLIENT_ID: z.string().optional(),
  GOOGLE_LOGIN_CLIENT_SECRET: z.string().optional(),
  GOOGLE_DATA_CLIENT_ID: z.string().optional(),
  GOOGLE_DATA_CLIENT_SECRET: z.string().optional(),
  GITHUB_LOGIN_CLIENT_ID: z.string().optional(),
  GITHUB_LOGIN_CLIENT_SECRET: z.string().optional(),
  GITHUB_DATA_CLIENT_ID: z.string().optional(),
  GITHUB_DATA_CLIENT_SECRET: z.string().optional(),

  STRIPE_SECRET_KEY: z.string().startsWith("sk_"),
  STRIPE_PUBLISHABLE_KEY: z.string().startsWith("pk_"),
  STRIPE_WEBHOOK_SECRET: z.string().startsWith("whsec_"),
  // Bug fix (b): client-side billing components read the NEXT_PUBLIC_ prefixed
  // name; the server keeps the unprefixed key for server-only routes.
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: z.string().startsWith("pk_").optional(),
  // Stripe Tax master switch. Ships dark ("false"); the provider reads
  // process.env.STRIPE_TAX_ENABLED directly so it stays edge/runtime-agnostic.
  STRIPE_TAX_ENABLED: z.string().optional(),

  // OXA-1349: INNGEST keys are optional in base schema.
  // @oxagen/inngest-functions enforces required-in-production itself.
  INNGEST_EVENT_KEY: z.string().optional(),
  INNGEST_SIGNING_KEY: z.string().optional(),

  // File/blob storage (avatars, uploaded images). Authenticates the Vercel Blob
  // driver behind @oxagen/storage. Optional in the base schema (not every
  // service uploads); the upload route enforces presence via requireEnv at call
  // time. Swapping to S3/R2 is a driver+env change — keep it isolated to config.
  BLOB_READ_WRITE_TOKEN: z.string().min(1).optional(),

  // Vercel AI Gateway — the platform's single AI auth boundary. AI_GATEWAY_API_KEY
  // authenticates every model call (text, image, embeddings, video); @oxagen/ai
  // routes 100% through the gateway with no direct-provider fallback. The
  // OXAGEN_LLM_* tiers are white-labeled model handles ("Oxagen Mini/Plus/Max")
  // that resolve to concrete gateway model ids in `creator/model` form. Defaults
  // mirror the registry staticValues so local dev and tests resolve a tier
  // without extra configuration.
  AI_GATEWAY_API_KEY: z.string().optional(),
  OXAGEN_LLM_FAST: z.string().default("anthropic/claude-haiku-4.5"),
  OXAGEN_LLM_BALANCED: z.string().default("anthropic/claude-sonnet-4.6"),
  OXAGEN_LLM_PRECISE: z.string().default("anthropic/claude-opus-4.8"),

  // Media-generation tiers. Image and video each expose a "basic" (default,
  // cheaper) and "advanced" tier that resolve to concrete gateway model ids,
  // mirroring the text tiers above. The composer's image/video model picker
  // shows "basic" as the default and "advanced" in the primary list; @oxagen/ai
  // resolves them via imageTierModelId / videoTierModelId.
  OXAGEN_LLM_IMAGE_BASIC: z.string().default("openai/gpt-image-1"),
  OXAGEN_LLM_IMAGE_ADVANCED: z.string().default("bfl/flux-2-max"),
  OXAGEN_LLM_VIDEO_BASIC: z.string().default("google/veo-3.0-fast-generate-001"),
  OXAGEN_LLM_VIDEO_ADVANCED: z.string().default("google/veo-3.0-generate-001"),

  // ── Email (transactional, via @oxagen/notifications SMTP transport) ──
  // Optional in the base schema (not every service sends mail); the
  // notifications transport enforces presence at first send via requireEnv and
  // fails closed with a precise error. SMTP is the vendor-neutral seam — Resend
  // today (host smtp.resend.com, username "resend", password = a Resend API
  // key); switching providers is an env-only change, no code change.
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_USERNAME: z.string().min(1).optional(),
  SMTP_PASSWORD: z.string().min(1).optional(),
  SMTP_FROM_EMAIL: z.string().email().optional(),
  SMTP_FROM_NAME: z.string().min(1).optional(),

  // Google Maps / Places API. NEXT_PUBLIC_GOOGLE_MAPS_API_KEY is the browser-
  // exposed API key used by the onboarding address autocomplete component; it
  // must be HTTP-referrer-restricted in the Google Cloud console. Optional so
  // builds stay green without it — the address form degrades to plain manual
  // entry when absent.
  // GOOGLE_MAPS_URL_SIGNING_SECRET is the server-only URL-signing secret.
  // It must NEVER be referenced in client bundle code. The NEXT_PUBLIC_ prefix
  // was removed (was NEXT_PUBLIC_GOOGLE_MAPS_API_SECRET) to prevent Next.js
  // from inlining it into the browser bundle — a signing secret must remain
  // server-side only.
  NEXT_PUBLIC_GOOGLE_MAPS_API_KEY: z.string().min(1).optional(),
  GOOGLE_MAPS_URL_SIGNING_SECRET: z.string().min(1).optional(),

  LINEAR_API_KEY: z.string().optional(),

  NEXT_PUBLIC_APP_URL: z.string().url(),
  NEXT_PUBLIC_API_URL: z.string().url(),
  // Server-side app origin for plugin OAuth authorize/callback URLs
  // (falls back to NEXT_PUBLIC_APP_URL at the call site).
  APP_URL: z.string().url().optional(),

  // Observability / feature flags — read raw via process.env in services and
  // libraries; declared here so env-check validates them against the registry.
  BETTER_AUTH_TRUSTED_ORIGINS: z.string().optional(),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).optional(),
  KNOWLEDGE_GRAPH_ENABLED: z.enum(["true", "false"]).optional(),
  MCP_PORT: z.string().optional(),

  // OXA-1348: when true (default off in prod), agent.code.execute is
  // materialized as an agent tool. Set true on Vercel once the Modal
  // runner is deployed (see ops/modal/README.md).
  // Accept "true"/"false" and "1"/"0" — a value pasted as 1/0 (a natural way
  // to express a boolean) still validates instead of failing env validation.
  SANDBOX_ENABLED: z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((v) => v === "true" || v === "1"),
  // Driver selection for @oxagen/sandbox. `modal` routes through the
  // hosted Firecracker runner; `docker` runs Dockerode locally; `vercel`
  // runs Firecracker microVMs via @vercel/sandbox (first-party, no extra
  // deployment needed on Vercel Functions). Unset = auto-detect (modal if
  // MODAL_RUNNER_URL is present, else docker). See ADR-011.
  SANDBOX_DRIVER: z.enum(["modal", "docker", "vercel"]).optional(),
  MODAL_RUNNER_URL: z.string().url().optional(),
  MODAL_RUNNER_TOKEN: z.string().min(16).optional(),
  // OXA-1348: Vercel Sandbox driver credentials. All three are optional
  // in the base schema because Vercel Functions auto-resolve auth via OIDC
  // (VERCEL_OIDC_TOKEN injected by the runtime). Only required for local
  // dev when SANDBOX_DRIVER=vercel outside a Vercel project.
  VERCEL_SANDBOX_TOKEN: z.string().min(1).optional(),
  VERCEL_SANDBOX_TEAM_ID: z.string().min(1).optional(),
  VERCEL_SANDBOX_PROJECT_ID: z.string().min(1).optional(),

  // OXA-1420: Vercel-native master key (KEK) used to wrap OAuth token data
  // encryption keys. Base64-encoded 256-bit (32-byte) key. Required in
  // production (enforced by the auth startup guard); optional in
  // development/test so local dev can boot without it. Generate with
  // `openssl rand -base64 32`.
  AUTH_TOKEN_ENCRYPTION_KEY: z.string().min(1).optional(),

  // OXA-1498: IAM enforcement gate. Secure by default: enforcement is ON
  // unless explicitly disabled. The kernel always resolves authz and emits
  // the ClickHouse + Postgres audit events on every capability call.
  // When true (default): denied invocations are blocked and a CapabilityError
  // is thrown — fail-closed behaviour required for SOC2 CC6/CC7.
  // Set IAM_ENFORCEMENT_ENABLED=false ONLY as a break-glass measure (e.g.
  // during an incident where IAM tables are unavailable or roles are
  // mis-seeded). Re-enable immediately after remediation.
  IAM_ENFORCEMENT_ENABLED: z
    .union([z.literal("true"), z.literal("false")])
    .optional()
    .transform((v) => v !== "false"),

  // OXA-1515: Row-Level Security enforcement gate. Default OFF during the
  // seeding window: withTenantDb always sets the scope GUCs, but additionally
  // sets app.rls_bypass='on' while this is false so the bypass-aware policies
  // do not yet filter. During seeding, isolation is still enforced by the
  // manual eq(orgId) predicates kept in every query. Flip to true per env
  // once db.query.unscoped telemetry reads zero. Reversible via env (no
  // migration needed).
  TENANT_RLS_ENFORCEMENT_ENABLED: z
    .union([z.literal("true"), z.literal("false")])
    .optional()
    .transform((v) => v === "true"),

  // ── Billing / usage-meter tuning (see @oxagen/billing pricing.ts) ──
  // Target *blended* gross margin across all products, in (0,1). When set,
  // it overrides DEFAULT_TARGET_MARGIN and re-derives the meter markup.
  OXAGEN_TARGET_MARGIN: z.coerce.number().gt(0).lt(1).optional(),
  // Operators pin the exact solved meter markup here so the runtime gate
  // never recomputes the blended-margin solve. `pnpm billing:stripe-sync`
  // prints the value to set. Must be >= 1 (a markup below 1 would sell
  // credits below provider cost).
  OXAGEN_METER_MARKUP: z.coerce.number().gte(1).optional(),

  // ── Usage-purchase volume discount (hybrid SaaS + usage pricing) ──
  // When a customer buys usage credits they earn a volume discount of
  // OXAGEN_USAGE_DISCOUNT_PERCENT% off for every OXAGEN_USAGE_DISCOUNT_INCREMENT
  // dollars purchased, scaling from $0 up to OXAGEN_USAGE_DISCOUNT_CEILING_USD
  // (above which it stays flat at the max). Percent + increment are the two
  // operator-tunable knobs; the ceiling bounds the curve so the discount can't
  // run away. Defaults: 3% per $50, ceiling $250 → max 15%.
  OXAGEN_USAGE_DISCOUNT_PERCENT: z.coerce.number().gte(0).lt(100).default(3),
  OXAGEN_USAGE_DISCOUNT_INCREMENT: z.coerce.number().gt(0).default(50),
  OXAGEN_USAGE_DISCOUNT_CEILING_USD: z.coerce.number().gt(0).default(250),
});

// The exact set of keys this schema validates. `normalizeEnv` only ever
// touches these — never arbitrary env vars another tool may have set.
const KNOWN_ENV_KEYS: ReadonlySet<string> = new Set(Object.keys(baseEnvSchema.shape));

/**
 * Strip one balanced surrounding double-quote pair from a string.
 * Used by both `normalizeEnv` and `platformVersion` — extracted here to
 * avoid duplicating the same one-liner in two places.
 *
 * @internal Not intended for public API use outside this package.
 */
export function stripOneQuotePair(s: string): string {
  return s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
}

export type Env = z.infer<typeof baseEnvSchema>;
export type EnvKey = keyof Env;

let cached: Env | null = null;

/**
 * Strip one balanced surrounding double-quote pair from **known** env keys.
 *
 * Env values pasted into the Vercel dashboard with literal quotes arrive
 * double-wrapped (`vercel env pull` writes `KEY="\"value\""`); Node's
 * `--env-file` unwraps only the outer pair, leaving `"value"` — which then
 * fails URL/enum validation. To keep the side-effect visible and bounded we
 * (a) only touch keys this schema actually validates — never arbitrary vars
 * another tool set — and (b) warn once, listing exactly what was stripped, so
 * a legitimately-quoted value isn't silently mutated.
 */
export function normalizeEnv(source: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  const stripped: string[] = [];
  for (const [key, value] of Object.entries(source)) {
    if (KNOWN_ENV_KEYS.has(key) && typeof value === "string") {
      const stripped_value = stripOneQuotePair(value);
      if (stripped_value !== value) {
        out[key] = stripped_value;
        stripped.push(key);
      } else {
        out[key] = value;
      }
    } else {
      out[key] = value;
    }
  }
  if (stripped.length > 0) {
    // packages/config is a root dependency that @oxagen/telemetry itself
    // depends on; importing a logger here would be circular. process.stderr
    // is the only viable output channel for this root package — intentional.
    process.stderr.write(
      JSON.stringify({
        level: "warn",
        pkg: "@oxagen/config",
        msg: `normalizeEnv stripped surrounding double-quotes from: ${stripped.join(", ")}. These values are double-quoted at the source (e.g. the Vercel dashboard) — fix them there.`,
      }) + "\n",
    );
  }
  return out;
}

/**
 * Validate the entire env once at process start. Appropriate for a top-level
 * service boot check (e.g. apps/api/src/index.ts). Individual packages should
 * call `requireEnv([...only their keys])` instead so importing a single
 * package does not require every var the whole monorepo defines.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  const parsed = baseEnvSchema.safeParse(normalizeEnv(source));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/**
 * Validate ONLY the env vars that a package actually uses.
 *
 * Builds a sub-schema by picking `keys` from `baseEnvSchema`, normalizes
 * `process.env` (quote-strip), and parses only those fields. Does NOT call
 * `loadEnv()` and does NOT require any key outside `keys`.
 *
 * Returns `Pick<Env, K>` typed — callers get exactly the vars they asked for.
 *
 * @example
 *   const env = requireEnv(["DATABASE_URL"] as const);
 *   // env.DATABASE_URL: string  ✓
 *   // env.NEO4J_URI             ← TS error, not in type
 */
export function requireEnv<K extends EnvKey>(
  keys: readonly K[],
  source: NodeJS.ProcessEnv = process.env,
): Pick<Env, K> {
  // Build a zod object containing only the requested keys.
  const shape = keys.reduce(
    (acc, k) => {
      // baseEnvSchema.shape is Record<EnvKey, ZodTypeAny>
      (acc as Record<string, z.ZodTypeAny>)[k] = baseEnvSchema.shape[k];
      return acc;
    },
    {} as { [Key in K]: (typeof baseEnvSchema.shape)[Key] },
  );
  const subSchema = z.object(shape);

  const normalized = normalizeEnv(source);
  const parsed = subSchema.safeParse(normalized);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment (required: ${keys.join(", ")}):\n${issues}`);
  }
  return parsed.data as Pick<Env, K>;
}

// Reset for tests only.
export function __resetEnvCacheForTests(): void {
  cached = null;
}

import { z } from "zod";

/**
 * True when the process is a PRODUCTION deployment. Reads the raw ambient env
 * directly (not the parsed schema) because it is consumed inside a field
 * transform — Zod field transforms cannot see sibling fields, and both
 * `loadEnv` and `requireEnv` ultimately parse `process.env`. VERCEL_ENV is the
 * authoritative signal on Vercel (preview deploys keep NODE_ENV=production yet
 * must NOT be treated as prod for fail-closed gating); NODE_ENV covers non-
 * Vercel production runtimes (self-hosted server, workers).
 */
export function isProductionRuntime(
  source: NodeJS.ProcessEnv = process.env,
): boolean {
  if (source.VERCEL_ENV) return source.VERCEL_ENV === "production";
  return source.NODE_ENV === "production";
}

// Apps subset the global schema via `requireEnv` and re-validate at boot.
// Spec §11: missing required vars fail closed, no silent defaults beyond
// what's marked optional here.
export const baseEnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  DATABASE_URL: z.string().url(),

  CLICKHOUSE_URL: z.string().url(),
  CLICKHOUSE_USERNAME: z.string().min(1),
  CLICKHOUSE_PASSWORD: z.string().default(""),
  CLICKHOUSE_DATABASE: z.string().default("oxagen"),

  NEO4J_URI: z.string().min(1),
  NEO4J_USERNAME: z.string().min(1),
  NEO4J_PASSWORD: z.string().min(1),
  NEO4J_DATABASE: z.string().default("neo4j"),

  // Circuit breakers for external dependencies (Neo4j / Stripe / ClickHouse).
  // Global, conservative defaults shared by every per-dependency breaker so a
  // degraded dependency fails fast instead of being hammered by every request.
  // See packages/telemetry/src/circuit-breaker.ts and breaker-clients.ts.
  //  - FAILURE_THRESHOLD: consecutive failures that trip a breaker open.
  //  - RESET_TIMEOUT_MS:  how long a tripped breaker stays open before a probe.
  //  - SUCCESS_THRESHOLD: consecutive probe successes that close it again.
  CIRCUIT_BREAKER_FAILURE_THRESHOLD: z.coerce
    .number()
    .int()
    .positive()
    .default(5),
  CIRCUIT_BREAKER_RESET_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(30000),
  CIRCUIT_BREAKER_SUCCESS_THRESHOLD: z.coerce
    .number()
    .int()
    .positive()
    .default(1),
  // Per-request timeout for the app MCP OAuth flows (lib/mcp-oauth/safe-fetch.ts).
  MCP_OAUTH_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),

  // Distributed rate limiter (apps/api/src/middleware/distributed-rate-limit.ts).
  // Per-workspace (fallback: per-org, then per-IP) fixed-window budgets, in
  // requests per minute, for the expensive chat + agent-execution surfaces.
  //  - RATE_LIMIT_CHAT_PER_MIN:       chat send / stream (/v1/**/chat/*).
  //  - RATE_LIMIT_AGENT_EXEC_PER_MIN: agent code-exec / compose / sandbox ops /
  //                                   background-task start, and the A2A RPC.
  RATE_LIMIT_CHAT_PER_MIN: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_AGENT_EXEC_PER_MIN: z.coerce.number().int().positive().default(30),

  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url(),

  // OAuth Proxy — preview deployments relay social login through the production
  // origin because OAuth providers only allow one registered callback. The proxy
  // encrypts the relay payload with OAUTH_PROXY_SECRET. Both are optional in the
  // base schema: local dev bypasses the proxy entirely, and production only needs
  // these when preview social login is enabled.
  OAUTH_PROXY_PRODUCTION_URL: z.string().url().optional(),
  OAUTH_PROXY_SECRET: z.string().min(32).optional(),

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
  // Pre-registered OAuth clients for MCP authorization servers without RFC 7591
  // dynamic client registration (GitHub MCP). JSON: endpoint host → client.
  // Malformed values are tolerated at runtime (logged + ignored), so the schema
  // only asserts string-ness, not JSON validity.
  MCP_OAUTH_PREREGISTERED_CLIENTS: z.string().optional(),

  // GitHub App OAuth — used for the data-connector OAuth flow (repo ingestion).
  // Separate from GITHUB_DATA_CLIENT_* (data client is for future use).
  // CLIENT_ID/SECRET identify the GitHub App itself; WEBHOOK_SECRET validates
  // inbound webhook payloads; INSTALL_STATE_SECRET signs the OAuth state param;
  // SLUG is the app's public path segment, used to deep-link users to GitHub's
  // install/configure page so they can add or remove orgs and repos.
  GITHUB_APP_CLIENT_ID: z.string().optional(),
  GITHUB_APP_CLIENT_SECRET: z.string().optional(),
  GITHUB_APP_WEBHOOK_SECRET: z.string().optional(),
  GITHUB_APP_INSTALL_STATE_SECRET: z.string().optional(),
  GITHUB_APP_SLUG: z.string().optional(),
  // ADR-020: per-workspace write credential resolution. When set, the
  // resolveGitHubToken() chain mints short-lived installation access tokens
  // via the App private key instead of falling back to per-user OAuth tokens.
  // Both vars are required together; omitting either disables path (1) and
  // falls through to the OAuth-connection fallback.
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  // LOCAL/DEMO-ONLY fallback PAT for GitHub write capabilities; must never be
  // set in production (bypasses per-workspace scoping — see resolveGitHubToken).
  GITHUB_PERSONAL_ACCESS_TOKEN: z.string().optional(),

  // Per-provider OAuth DATA client credentials for token refresh (ingestion cron).
  // All are optional in the base schema — the ingestion.oauth-refresh function
  // checks them at runtime and skips the provider with a clear log if absent.
  // Slack token rotation MUST be enabled in the Slack app settings.
  SLACK_DATA_CLIENT_ID: z.string().optional(),
  SLACK_DATA_CLIENT_SECRET: z.string().optional(),
  ZOOM_DATA_CLIENT_ID: z.string().optional(),
  ZOOM_DATA_CLIENT_SECRET: z.string().optional(),
  SALESFORCE_DATA_CLIENT_ID: z.string().optional(),
  SALESFORCE_DATA_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_DATA_CLIENT_ID: z.string().optional(),
  MICROSOFT_DATA_CLIENT_SECRET: z.string().optional(),

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

  // Storage driver selection for @oxagen/storage. Determines which blob-storage
  // backend is instantiated by storage(). Defaults to "vercel-blob" so existing
  // deployments are unaffected. Adding a new driver requires: (1) implementing
  // the StorageAdapter interface, (2) extending this enum, (3) adding a case
  // in client.ts resolveAdapter(). See docs/guides/storage-driver-authoring.md.
  STORAGE_DRIVER: z
    .enum(["vercel-blob", "fs"])
    .default("vercel-blob")
    .optional(),

  // Root directory for the "fs" storage driver. Only read when STORAGE_DRIVER=fs
  // (the CI e2e container and local dev without a Vercel Blob token). Absolute
  // paths are used as-is; a relative path is anchored at process.cwd(). When
  // unset the driver defaults to an OS-tmp-scoped directory. See
  // docs/guides/storage-driver-authoring.md.
  STORAGE_FS_ROOT: z.string().min(1).optional(),

  // Vercel AI Gateway — the platform's default AI auth boundary.
  // AI_GATEWAY_API_KEY authenticates every model call (text, image, embeddings,
  // video). The OXAGEN_LLM_* tiers are white-labeled model handles ("Oxagen
  // Mini/Plus/Max") resolving to concrete model ids in `creator/model` form.
  // Defaults mirror the registry staticValues so local dev and tests resolve a
  // tier without extra configuration.
  AI_GATEWAY_API_KEY: z.string().optional(),
  // Which provider serves LANGUAGE models. The gateway is the default and the
  // metered path; "openrouter" selects a direct OpenAI-compatible provider for
  // a deployment that cannot reach the gateway — the AWS instance behind
  // app.oxagen.sh, whose gateway credential 401s while the Vercel account is
  // suspended. Never an automatic fallback: an operator opting out says so
  // here, because a silent failover would move spend to another vendor's bill
  // and skip the metering the gateway exists to provide.
  //
  // Image, video and embeddings stay on the gateway either way — OpenRouter
  // serves none of them. See packages/ai/src/models.ts.
  OXAGEN_MODEL_PROVIDER: z.enum(["gateway", "openrouter"]).default("gateway"),
  // Required only when OXAGEN_MODEL_PROVIDER=openrouter; optional here so every
  // other deployment stays valid without it.
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  OXAGEN_LLM_FAST: z.string().default("anthropic/claude-haiku-4.5"),
  OXAGEN_LLM_BALANCED: z.string().default("anthropic/claude-sonnet-5"),
  OXAGEN_LLM_PRECISE: z.string().default("anthropic/claude-fable-5"),
  // CLI turn-pipeline overrides. Optional: the CLI resolves the fast tier for the
  // evaluator and the precise tier for the advisor when these are unset.
  OXAGEN_LLM_EVALUATOR: z.string().optional(),
  OXAGEN_LLM_ADVISOR: z.string().optional(),
  // Best-of-N comparative selector override. Optional: defaults to the
  // flagship Anthropic model (Fable 5) when unset — see select.ts's
  // DEFAULT_SELECTOR_MODEL.
  OXAGEN_LLM_SELECTOR: z.string().optional(),
  // "1" makes buildWorkspaceTools structurally deny edit_file/write_file on
  // test-shaped paths (SWE-bench-style anti-reward-hacking guard).
  OXAGEN_FORBID_TEST_EDITS: z.string().optional(),

  // Media-generation tiers. Image and video each expose a "basic" (default,
  // cheaper) and "advanced" tier that resolve to concrete gateway model ids,
  // mirroring the text tiers above. The composer's image/video model picker
  // shows "basic" as the default and "advanced" in the primary list; @oxagen/ai
  // resolves them via imageTierModelId / videoTierModelId.
  OXAGEN_LLM_IMAGE_BASIC: z.string().default("openai/gpt-image-1"),
  OXAGEN_LLM_IMAGE_ADVANCED: z.string().default("bfl/flux-2-max"),
  OXAGEN_LLM_VIDEO_BASIC: z
    .string()
    .default("google/veo-3.0-fast-generate-001"),
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
  // Public marketing website origin (oxagen.sh). Used by the /v1/cms/* lead
  // routes to build the emailed reader link ({MARKETING_URL}/read?…) and by
  // CORS to allow the static site's cross-origin lead/redeem fetches. Optional —
  // resolveMarketingUrl() falls back to a per-environment default.
  MARKETING_URL: z.string().url().optional(),
  // Public origin advertised in the A2A Agent Card / well-known URL. Optional —
  // A2A routes derive the origin from the live request; overrides only apply to
  // out-of-band card reads. Falls back to the API origin.
  A2A_PUBLIC_URL: z.string().url().optional(),
  // Browser-exposed docs-site origin override (apps/app docs links). Optional —
  // getDocsBaseUrl() resolves a correct dev/prod default when unset.
  NEXT_PUBLIC_DOCS_URL: z.string().url().optional(),
  // chat_ux_v2 feature flag (apps/app chat UX overhaul). "1" enables the new
  // session-settings chat surface environment-wide; unset/anything else = off.
  // A per-browser cookie override (`?chat_ux_v2=1|0`, see apps/app proxy.ts)
  // wins over this default. Remove once the v2 surface fully replaces v1.
  NEXT_PUBLIC_CHAT_UX_V2: z.enum(["0", "1"]).optional(),
  // MCP protocol endpoint origin surfaced by system.install.instructions.
  // Optional — the handler falls back to the prod MCP URL when unset.
  MCP_URL: z.string().url().optional(),

  // Observability / feature flags — read raw via process.env in services and
  // libraries; declared here so env-check validates them against the registry.
  BETTER_AUTH_TRUSTED_ORIGINS: z.string().optional(),
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .optional(),
  KNOWLEDGE_GRAPH_ENABLED: z.enum(["true", "false"]).optional(),
  MCP_PORT: z.string().optional(),

  // ── OpenTelemetry (vendor-neutral OTLP export) ──
  // The distributed tracer (packages/telemetry/src/tracer.ts) reads these raw
  // at process start; declared here so `pnpm env:check` validates their shape.
  // When OTEL_EXPORTER_OTLP_ENDPOINT is unset the SDK never starts and every
  // span is a no-op — safe for all envs, rollback = leave unset. BYO collector
  // (any OTLP/HTTP endpoint — Grafana, Honeycomb, Jaeger, an OTel Collector);
  // no vendor SDK is bundled. OTEL_EXPORTER_OTLP_HEADERS is the standard
  // W3C-style comma-separated `key=value` list (e.g. auth headers for the
  // collector), matching the OTEL spec env var; parsed by the tracer.
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  OTEL_EXPORTER_OTLP_HEADERS: z.string().optional(),
  OTEL_SERVICE_NAME: z.string().min(1).optional(),

  // ── Error alerting (vendor-neutral outbound webhook) ──
  // When set, high-severity/unhandled server errors captured by
  // @oxagen/telemetry's captureError() are POSTed as a Slack-compatible JSON
  // payload to this URL (Slack/Mattermost/Discord-compatible incoming webhook,
  // or any endpoint that accepts `{ text, blocks }`). BYO webhook — no vendor
  // SDK. Optional: unset = ClickHouse error_events recording only, no webhook.
  ALERT_WEBHOOK_URL: z.string().url().optional(),

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

  // OXA-1720: ingestion connector-credential encryption. INGESTION_CRYPTO_PROVIDER
  // selects the KMS adapter: "env" (default) wraps with a local base64 master key
  // held in INGESTION_ENCRYPTION_KEY; "kms" wraps via AWS KMS keyed by
  // AWS_KMS_INGESTION_KEY_ARN. All optional in the base schema — createIngestion-
  // CryptoAdapter() enforces the provider-specific key at startup and fails closed.
  INGESTION_CRYPTO_PROVIDER: z.enum(["env", "kms"]).default("env").optional(),
  AWS_KMS_INGESTION_KEY_ARN: z.string().min(1).optional(),
  INGESTION_ENCRYPTION_KEY: z.string().min(1).optional(),
  // Base64 master key for encrypting per-org reseller Stripe keys (reseller
  // revenue). Optional: reseller-secret.ts falls back to INGESTION_ENCRYPTION_KEY.
  BILLING_ENCRYPTION_KEY: z.string().min(1).optional(),
  // Audit-export download-URL signing (HMAC). Optional dedicated secret; the
  // route falls back to BETTER_AUTH_SECRET. Must be >= 16 bytes when set
  // (enforced at the signing call site in the audit export route).
  AUDIT_EXPORT_SIGNING_SECRET: z.string().min(16).optional(),

  // Privacy erasure grace period in days before hard-delete runs. Optional —
  // privacy.data.erase defaults to 30; 0 forces immediate erasure (test envs).
  PRIVACY_ERASURE_GRACE_DAYS: z.coerce.number().int().nonnegative().optional(),

  // Tavily web-search API key (web.search capability). Optional in the base
  // schema; packages/web throws a precise error at call time when it is absent.
  TAVILY_API_KEY: z.string().min(1).optional(),

  // OXA-1515: Row-Level Security enforcement gate. Fail-CLOSED in production:
  // when unset, this defaults ON in any production runtime (NODE_ENV or
  // VERCEL_ENV = "production") and OFF everywhere else (dev/test/preview seeding
  // window). withTenantDb always sets the scope GUCs; when this resolves false
  // it additionally sets app.rls_bypass='on' so the bypass-aware policies do not
  // yet filter (isolation still enforced by the manual eq(orgId) predicates kept
  // in every query). An operator can still force it OFF in production with an
  // explicit "false", but the startup guard (assertRlsEnforcedInProduction)
  // refuses to boot in that state — a production process may not run unscoped.
  // Reversible via env (no migration needed).
  TENANT_RLS_ENFORCEMENT_ENABLED: z
    .union([z.literal("true"), z.literal("false")])
    .optional()
    .transform((v) => (v === undefined ? isProductionRuntime() : v === "true")),

  // ── CLI debugging ──
  OXAGEN_CODE_GRAPH_DEBUG: z.string().optional(),

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

  // ── SWE-bench optimization: spec-first oracle & adaptive ladder ──
  // F2 spec-first oracle: at mid-judge, if no failing test reproduction exists,
  // inject a corrective instruction instead of generic completeness feedback.
  // Enforces test-before-patch discipline to prevent wrong-spec patches.
  OXAGEN_SPEC_GATE: z
    .union([
      z.literal("1"),
      z.literal("true"),
      z.literal("0"),
      z.literal("false"),
    ])
    .optional()
    .transform((v) => v === "1" || v === "true"),
  // Deterministic judge-skip / adaptive compute ladder (ADR-021 §1). ON by
  // DEFAULT: when executed evidence (oracle flipped + tests green + diff size,
  // or a read-only turn with no diff) already settles completeness, the frontier
  // completeness judge is skipped. Set to 0/false to OPT OUT and force the judge
  // to run every round. Normalized boolean = "judge-skip enabled".
  OXAGEN_LADDER: z
    .union([
      z.literal("1"),
      z.literal("true"),
      z.literal("0"),
      z.literal("false"),
    ])
    .optional()
    .transform((v) => v !== "0" && v !== "false"),
  // Diff line count threshold for fast-path submission (default 120).
  // When oracle flipped + tests green + diff ≤ budget, skip judge.
  OXAGEN_DIFF_BUDGET: z.coerce.number().positive().default(120),
  // Hard cap on ladder rung (0–3); prevents escalation beyond specified level.
  // 0 = fast-path only, 3 = no cap (default).
  OXAGEN_LADDER_MAX_RUNG: z.coerce.number().int().min(0).max(3).default(3),
});

// The exact set of keys this schema validates. `normalizeEnv` only ever
// touches these — never arbitrary env vars another tool may have set.
const KNOWN_ENV_KEYS: ReadonlySet<string> = new Set(
  Object.keys(baseEnvSchema.shape),
);

/**
 * Strip one balanced surrounding double-quote pair from a string.
 * Used by both `normalizeEnv` and `platformVersion` — extracted here to
 * avoid duplicating the same one-liner in two places.
 *
 * @internal Not intended for public API use outside this package.
 */
export function stripOneQuotePair(s: string): string {
  return s.length >= 2 && s.startsWith('"') && s.endsWith('"')
    ? s.slice(1, -1)
    : s;
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
export function normalizeEnv(
  source: NodeJS.ProcessEnv,
): Record<string, string | undefined> {
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
    throw new Error(
      `Invalid environment (required: ${keys.join(", ")}):\n${issues}`,
    );
  }
  return parsed.data as Pick<Env, K>;
}

// Reset for tests only.
export function __resetEnvCacheForTests(): void {
  cached = null;
}

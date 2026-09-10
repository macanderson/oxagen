import { baseEnvSchema } from "./env";

// ─────────────────────────────────────────────────────────────────────────────
// Canonical environment-variable registry — the single source of truth for
// "what every variable is, which deployable surfaces need it, where its value
// comes from, and how it's documented."
//
// Everything else derives from this:
//   - `.env.example`            → `renderEnvExample()` (generated, never hand-edited)
//   - env-manager deploy catalog → `tools/env-manager/src/catalog.ts`
//   - the static CI checker      → `tools/scripts/env-check.ts`
//
// The Zod `baseEnvSchema` (env.ts) remains the *runtime validator*; this registry
// is a documentation/deployment superset of it. A variable is "schema-validated"
// iff it appears in `baseEnvSchema` — computed by `isValidated()`, never a
// hand-maintained flag, so the two can't silently diverge. `registry.test.ts`
// asserts every schema key has a registry entry.
// ─────────────────────────────────────────────────────────────────────────────

/** A deployable Vercel project surface. */
export type ServiceName = "api" | "app" | "mcp" | "website" | "admin" | "docs";

/** A deployment environment (matches Vercel's three targets). */
export type EnvName = "development" | "preview" | "production";

export const SERVICE_NAMES: readonly ServiceName[] = [
  "api",
  "app",
  "mcp",
  "website",
  "admin",
  "docs",
];
export const ENV_NAMES: readonly EnvName[] = [
  "development",
  "preview",
  "production",
];

/**
 * Where a variable's value originates when the env-manager deploys it.
 *  - `static`:   a literal baked into this registry (`staticValue` per env or shared).
 *  - `generate`: a fresh random secret minted by the env-manager (kept consistent
 *                across an env+key so e.g. api and app share one auth secret).
 *  - `manual`:   the operator supplies the value (paste-a-secret in the UI, or set
 *                it on a provider dashboard). The env-manager never invents it.
 */
export type ValueOrigin = "static" | "generate" | "manual";

export interface EnvVarMeta {
  /** Section heading, used to group `.env.example` and the env-manager UI. */
  group: string;
  /** One-line human description. Becomes the comment above the var in `.env.example`. */
  description: string;
  /** Stored on Vercel as `encrypted` (true) vs `plain`/readable (false). */
  secret: boolean;
  /** Inlined into a client bundle (the `NEXT_PUBLIC_` convention). */
  clientExposed: boolean;
  /** Which Vercel projects need this var to function. Empty = operator/tooling-only. */
  services: ServiceName[];
  /** Environments where a value MUST be present (drives the gap detector). */
  requiredIn: EnvName[];
  /** Where the value comes from when deployed. */
  valueOrigin: ValueOrigin;
  /**
   * Per-env static values (only for `valueOrigin: "static"`). Use the `"*"` key
   * for a value shared across every environment.
   */
  staticValue?: Partial<Record<EnvName | "*", string>>;
  /** Optional example/placeholder shown in `.env.example` for non-static vars. */
  placeholder?: string;
}

const ALL: EnvName[] = ["development", "preview", "production"];
const DEPLOYED: EnvName[] = ["preview", "production"];

const APP_PROD_URL = "https://app.oxagen.sh";
const API_PROD_URL = "https://api.oxagen.sh";
const MCP_PROD_URL = "https://mcp.oxagen.sh";
const MARKETING_PROD_URL = "https://oxagen.sh";

/**
 * The registry. Ordered for `.env.example` layout. `services`/`requiredIn`
 * reflect real consumers (derived from the source-reference audit); preserve
 * the env-manager catalog's historical routing where it was already tuned.
 */
export const ENV_REGISTRY: Record<string, EnvVarMeta> = {
  // ── Node ──────────────────────────────────────────────────────────────────
  NODE_ENV: {
    group: "Node",
    description: "Runtime mode. Vercel/Next set this automatically per deploy.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "static",
    staticValue: {
      development: "development",
      preview: "production",
      production: "production",
    },
  },

  // ── Postgres (Neon in prod, Docker locally) ─────────────────────────────────
  DATABASE_URL: {
    group: "Postgres",
    description:
      "Neon Postgres connection string. Prod = live branch; preview/dev = dev branch.",
    secret: true,
    clientExposed: false,
    services: ["api", "app", "mcp", "admin"],
    requiredIn: ALL,
    valueOrigin: "manual",
    placeholder: "postgres://oxagen:oxagen@localhost:5433/oxagen",
  },

  // ── ClickHouse (append-only telemetry store) ────────────────────────────────
  CLICKHOUSE_URL: {
    group: "ClickHouse",
    description: "ClickHouse HTTPS endpoint.",
    secret: false,
    clientExposed: false,
    services: ["api", "app", "mcp"],
    requiredIn: ALL,
    valueOrigin: "manual",
    placeholder: "http://localhost:8123",
  },
  CLICKHOUSE_USERNAME: {
    group: "ClickHouse",
    description: "ClickHouse user.",
    secret: false,
    clientExposed: false,
    services: ["api", "app", "mcp"],
    requiredIn: ALL,
    valueOrigin: "manual",
    placeholder: "default",
  },
  CLICKHOUSE_PASSWORD: {
    group: "ClickHouse",
    description: "ClickHouse password (empty for local Docker).",
    secret: true,
    clientExposed: false,
    services: ["api", "app", "mcp"],
    requiredIn: [],
    valueOrigin: "manual",
  },
  CLICKHOUSE_DATABASE: {
    group: "ClickHouse",
    description: "ClickHouse database name.",
    secret: false,
    clientExposed: false,
    services: ["api", "app", "mcp"],
    requiredIn: [],
    valueOrigin: "static",
    staticValue: { "*": "oxagen" },
  },

  // ── Neo4j (portable knowledge graph) ────────────────────────────────────────
  NEO4J_URI: {
    group: "Neo4j",
    description: "Neo4j bolt(+s) URI.",
    secret: false,
    clientExposed: false,
    services: ["api", "app", "mcp"],
    requiredIn: ALL,
    valueOrigin: "manual",
    placeholder: "bolt://localhost:7687",
  },
  NEO4J_USERNAME: {
    group: "Neo4j",
    description: "Neo4j user.",
    secret: false,
    clientExposed: false,
    services: ["api", "app", "mcp"],
    requiredIn: ALL,
    valueOrigin: "manual",
    placeholder: "neo4j",
  },
  NEO4J_PASSWORD: {
    group: "Neo4j",
    description: "Neo4j password.",
    secret: true,
    clientExposed: false,
    services: ["api", "app", "mcp"],
    requiredIn: ALL,
    valueOrigin: "manual",
  },
  NEO4J_DATABASE: {
    group: "Neo4j",
    description: "Neo4j database.",
    secret: false,
    clientExposed: false,
    services: ["api", "app", "mcp"],
    requiredIn: [],
    valueOrigin: "static",
    staticValue: { "*": "neo4j" },
  },

  // ── OpenTelemetry (distributed tracing) ─────────────────────────────────────
  OTEL_EXPORTER_OTLP_ENDPOINT: {
    group: "OpenTelemetry",
    description:
      "OTLP HTTP collector URL (e.g. https://otel.example.com/v1/traces). " +
      "When unset the SDK does not start and all spans are no-ops — safe for all envs. " +
      "Rollback = leave unset.",
    secret: false,
    clientExposed: false,
    services: ["api", "app", "mcp"],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "https://otel.example.com/v1/traces",
  },
  OTEL_EXPORTER_OTLP_HEADERS: {
    group: "OpenTelemetry",
    description:
      "Standard OTEL comma-separated `key=value` header list sent to the collector " +
      '(e.g. "authorization=Bearer xxx,x-tenant=oxagen"). Optional — for collectors ' +
      "that require auth headers. Parsed by packages/telemetry/src/tracer.ts.",
    secret: true,
    clientExposed: false,
    services: ["api", "app", "mcp"],
    requiredIn: [],
    valueOrigin: "manual",
  },
  OTEL_SERVICE_NAME: {
    group: "OpenTelemetry",
    description:
      "Service name tag on OTEL span resources (default: oxagen). " +
      "Optional — leave unset to use the default.",
    secret: false,
    clientExposed: false,
    services: ["api", "app", "mcp"],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "oxagen",
  },

  // ── Circuit breaker (shared thresholds for every per-dependency breaker —
  //    Neo4j scopedSession, Stripe BillingProvider, ClickHouse insertRows) ────
  CIRCUIT_BREAKER_FAILURE_THRESHOLD: {
    group: "Circuit breaker",
    description:
      "Consecutive failures before a breaker opens for a wrapped dependency call " +
      "(Neo4j / Stripe / ClickHouse). Optional — defaults to 5 in packages/config/src/env.ts.",
    secret: false,
    clientExposed: false,
    services: ["api", "app", "mcp"],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "5",
  },
  CIRCUIT_BREAKER_RESET_TIMEOUT_MS: {
    group: "Circuit breaker",
    description:
      "Milliseconds an open breaker waits before allowing a trial (half-open) request. " +
      "Optional — defaults to 30000 in packages/config/src/env.ts.",
    secret: false,
    clientExposed: false,
    services: ["api", "app", "mcp"],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "30000",
  },
  MCP_OAUTH_FETCH_TIMEOUT_MS: {
    group: "MCP",
    description:
      "Per-request timeout (ms) for the app MCP OAuth authorize/callback flows " +
      "when the MCP SDK fetches a third-party authorization server well-known / " +
      "token endpoints. Bounds a hung server so it cannot stall the serverless " +
      "function. Optional — defaults to 10000 in lib/mcp-oauth/safe-fetch.ts.",
    secret: false,
    clientExposed: false,
    services: ["app"],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "10000",
  },
  CIRCUIT_BREAKER_SUCCESS_THRESHOLD: {
    group: "Circuit breaker",
    description:
      "Consecutive successes required in the half-open state before a breaker closes. " +
      "Optional — defaults to 1 in packages/config/src/env.ts.",
    secret: false,
    clientExposed: false,
    services: ["api", "app", "mcp"],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "1",
  },

  // ── Rate limiting (distributed, Postgres-backed) ────────────────────────────
  RATE_LIMIT_CHAT_PER_MIN: {
    group: "Rate limiting",
    description:
      "Max chat send/stream requests per minute per workspace (fallback: per org, " +
      "then per IP) on /v1/**/chat/*. Optional — defaults to 60 in packages/config/src/env.ts.",
    secret: false,
    clientExposed: false,
    services: ["api"],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "60",
  },

  TRUSTED_PROXY_HOP_COUNT: {
    group: "Rate limiting",
    description:
      "How many proxies sit in front of apps/api and append to x-forwarded-for. " +
      "The client IP the IAM ip_ranges allowlist checks is the Nth entry from the " +
      "right; entries left of it are caller-supplied. Optional — defaults to 1 " +
      "(one ALB) in packages/config/src/env.ts. 0 disables the header entirely.",
    secret: false,
    clientExposed: false,
    services: ["api"],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "1",
  },

  // ── Error alerting (vendor-neutral outbound webhook) ────────────────────────
  ALERT_WEBHOOK_URL: {
    group: "Error alerting",
    description:
      "When set, high-severity/unhandled server errors are POSTed as a Slack-compatible " +
      "`{ text, blocks }` JSON payload here (Slack/Mattermost/Discord incoming webhook, or " +
      "any compatible endpoint). BYO webhook — no vendor SDK. When unset, errors are still " +
      "recorded to the ClickHouse error_events table; only the webhook alert is skipped.",
    secret: true,
    clientExposed: false,
    services: ["api", "app", "mcp"],
    requiredIn: [],
    valueOrigin: "manual",
  },

  // ── Better Auth ─────────────────────────────────────────────────────────────
  BETTER_AUTH_SECRET: {
    group: "Better Auth",
    description:
      "Session/cookie signing secret (≥32 chars). Minted once per env and applied " +
      "identically to api + app so sessions validate across both.",
    secret: true,
    clientExposed: false,
    services: ["api", "app"],
    requiredIn: ALL,
    valueOrigin: "generate",
  },
  BETTER_AUTH_URL: {
    group: "Better Auth",
    description: "Auth base URL (the app origin).",
    secret: false,
    clientExposed: false,
    services: ["api", "app"],
    requiredIn: ALL,
    valueOrigin: "static",
    staticValue: {
      development: "http://localhost:3000",
      production: APP_PROD_URL,
    },
  },
  BETTER_AUTH_TRUSTED_ORIGINS: {
    group: "Better Auth",
    description:
      "Space-separated origins allowed cross-origin access to the auth API.",
    secret: false,
    clientExposed: false,
    services: ["api", "app"],
    requiredIn: [],
    valueOrigin: "static",
    staticValue: {
      development: "http://localhost:3000",
      production: APP_PROD_URL,
    },
  },
  AUTH_TOKEN_ENCRYPTION_KEY: {
    group: "Better Auth",
    description:
      "Base64 256-bit KEK that wraps OAuth token encryption keys. Required in " +
      "preview+production (enforced by the auth startup guard); blank locally disables it. " +
      "Generate with `openssl rand -base64 32`.",
    secret: true,
    clientExposed: false,
    services: ["api", "app"],
    requiredIn: DEPLOYED,
    valueOrigin: "manual",
  },
  OAUTH_PROXY_PRODUCTION_URL: {
    group: "Better Auth",
    description:
      "Canonical production origin the shared social-login OAuth app's callback is " +
      "registered against (OAuth Proxy productionURL). Preview deployments relay social " +
      "login through this origin. Defaults to the production app URL when unset.",
    secret: false,
    clientExposed: false,
    services: ["api", "app"],
    requiredIn: [],
    valueOrigin: "static",
    staticValue: { development: APP_PROD_URL, production: APP_PROD_URL },
  },
  OAUTH_PROXY_SECRET: {
    group: "Better Auth",
    description:
      "Dedicated secret the OAuth Proxy uses to encrypt/decrypt the relay payload " +
      "between production and preview deployments. MUST be set to the SAME value in " +
      "production AND preview for preview social login to work (production alone only " +
      "passes through). Kept separate from BETTER_AUTH_SECRET to limit blast radius. " +
      "Generate with `openssl rand -base64 32`.",
    secret: true,
    clientExposed: false,
    services: ["api", "app"],
    requiredIn: [],
    valueOrigin: "manual",
  },

  // ── OAuth providers ─────────────────────────────────────────────────────────
  // Google OAuth is split into a LOGIN client (minimal openid/profile/email,
  // in use for social sign-in) and a DATA client (Workspace data scopes,
  // reserved for the future google-workspace connection).
  GOOGLE_LOGIN_CLIENT_ID: {
    group: "OAuth providers",
    description:
      "Google LOGIN OAuth client id (social sign-in; minimal scopes).",
    secret: false,
    clientExposed: false,
    services: ["api", "app"],
    requiredIn: [],
    valueOrigin: "manual",
  },
  GOOGLE_LOGIN_CLIENT_SECRET: {
    group: "OAuth providers",
    description: "Google LOGIN OAuth client secret.",
    secret: true,
    clientExposed: false,
    services: ["api", "app"],
    requiredIn: [],
    valueOrigin: "manual",
  },
  GOOGLE_DATA_CLIENT_ID: {
    group: "OAuth providers",
    description:
      "Google DATA OAuth client id (Workspace data scopes; future connection).",
    secret: false,
    clientExposed: false,
    services: ["api", "app"],
    requiredIn: [],
    valueOrigin: "manual",
  },
  GOOGLE_DATA_CLIENT_SECRET: {
    group: "OAuth providers",
    description: "Google DATA OAuth client secret.",
    secret: true,
    clientExposed: false,
    services: ["api", "app"],
    requiredIn: [],
    valueOrigin: "manual",
  },
  // GitHub mirrors the Google split: a LOGIN client (social sign-in, in use)
  // and a DATA client (repo-ingestion scopes, reserved for the future
  // github connection — keeps repo-access scopes off the plain-login client).
  GITHUB_LOGIN_CLIENT_ID: {
    group: "OAuth providers",
    description:
      "GitHub LOGIN OAuth client id (social sign-in; minimal scopes).",
    secret: false,
    clientExposed: false,
    services: ["api", "app"],
    requiredIn: [],
    valueOrigin: "manual",
  },
  GITHUB_LOGIN_CLIENT_SECRET: {
    group: "OAuth providers",
    description: "GitHub LOGIN OAuth client secret.",
    secret: true,
    clientExposed: false,
    services: ["api", "app"],
    requiredIn: [],
    valueOrigin: "manual",
  },
  MCP_OAUTH_PREREGISTERED_CLIENTS: {
    group: "OAuth providers",
    description:
      "Pre-registered OAuth clients for MCP authorization servers that do NOT support " +
      "RFC 7591 dynamic client registration (GitHub MCP, notably). JSON object mapping " +
      "the MCP server's endpoint HOST to the client registered with that provider, e.g. " +
      '{"api.githubcopilot.com":{"client_id":"…","client_secret":"…"}}. Each provider ' +
      "app must list <app-origin>/api/v1/mcp/oauth/callback as its callback URL. When a " +
      "host is absent the flow falls back to dynamic client registration as before.",
    secret: true,
    clientExposed: false,
    services: ["api", "app"],
    requiredIn: [],
    valueOrigin: "manual",
  },

  // ── GitHub App (connector OAuth + webhooks) ──────────────────────────────────
  GITHUB_APP_CLIENT_ID: {
    group: "github",
    description:
      "GitHub App OAuth client id — used for the data-connector OAuth flow.",
    secret: false,
    clientExposed: false,
    services: ["api"],
    requiredIn: [],
    valueOrigin: "manual",
  },
  GITHUB_APP_CLIENT_SECRET: {
    group: "github",
    description: "GitHub App OAuth client secret.",
    secret: true,
    clientExposed: false,
    services: ["api"],
    requiredIn: [],
    valueOrigin: "manual",
  },
  GITHUB_APP_WEBHOOK_SECRET: {
    group: "github",
    description:
      "GitHub App webhook signing secret — validates inbound webhook payloads.",
    secret: true,
    clientExposed: false,
    services: ["api"],
    requiredIn: [],
    valueOrigin: "manual",
  },
  GITHUB_WEBHOOK_SECRET: {
    group: "github",
    description:
      "Webhook signing secret for the SECOND GitHub App (oxagen-sh, app id " +
      "4055615), which delivers to the same /webhooks/github/app endpoint as " +
      "oxagen-code-agent. Optional: unset means that App's deliveries are rejected.",
    secret: true,
    clientExposed: false,
    services: ["api"],
    requiredIn: [],
    valueOrigin: "manual",
  },
  GITHUB_APP_INSTALL_STATE_SECRET: {
    group: "github",
    description:
      "HMAC secret used to sign the OAuth state parameter for GitHub App installs.",
    secret: true,
    clientExposed: false,
    services: ["api"],
    requiredIn: [],
    valueOrigin: "manual",
  },
  GITHUB_APP_SLUG: {
    group: "github",
    description:
      "GitHub App public slug (the path segment in https://github.com/apps/<slug>). Used to deep-link users to GitHub's install/configure page so they can add or remove orgs and repos. Optional — when unset the connection dialog derives the slug from an existing installation.",
    secret: false,
    clientExposed: false,
    services: ["api"],
    requiredIn: [],
    valueOrigin: "manual",
  },

  // Per-workspace write credential resolution
  // (docs/adr/ADR-020-per-workspace-github-write-credentials.md).
  // GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY enable the installation-token path
  // in resolveGitHubToken(). Both must be set together; omitting either falls
  // through to the OAuth-connection or env-PAT fallback.
  GITHUB_APP_ID: {
    group: "github",
    description:
      "GitHub App numeric ID. Required (with GITHUB_APP_PRIVATE_KEY) for the installation-token path in resolveGitHubToken(). Find it on the GitHub App settings page.",
    secret: false,
    clientExposed: false,
    services: ["api", "mcp"],
    requiredIn: [],
    valueOrigin: "manual",
  },

  GITHUB_APP_PRIVATE_KEY: {
    group: "github",
    description:
      "PEM-encoded RSA private key for the GitHub App. Required (with GITHUB_APP_ID) for the installation-token path in resolveGitHubToken(). Generate in the GitHub App settings → Private keys.",
    secret: true,
    clientExposed: false,
    services: ["api", "mcp"],
    requiredIn: [],
    valueOrigin: "manual",
  },

  GITHUB_PERSONAL_ACCESS_TOKEN: {
    group: "github",
    description:
      "Personal access token (PAT) used by GitHub write capabilities (repo.create, repo.file.put, repo.fork, repo.branch.create, repo.pr.open) as a LOCAL/DEMO-ONLY fallback. Per-workspace credential resolution is now live (GitHub App installation token + KMS-encrypted per-workspace OAuth — see resolveGitHubToken in packages/handlers/src/lib/github-token.ts), so this MUST NOT be set in production: a shared PAT bypasses per-workspace scoping. resolveGitHubToken logs a loud warning when it is used while NODE_ENV=production.",
    secret: true,
    clientExposed: false,
    services: ["api"],
    requiredIn: [],
    valueOrigin: "manual",
  },

  // ── Ingestion OAuth DATA client credentials ──────────────────────────────────
  // Per-provider OAuth client pairs used exclusively by the ingestion
  // oauth-refresh Inngest cron (packages/inngest-functions).  All are optional —
  // the cron skips a provider with a clear log when the env is absent.
  // Slack: token rotation MUST be enabled in the Slack app settings before
  // deploying SLACK_DATA_CLIENT_* (without it Slack rejects the refresh request).
  SLACK_DATA_CLIENT_ID: {
    group: "Ingestion",
    description:
      "Slack DATA OAuth client id for token refresh (ingestion cron). Token rotation must be enabled in the Slack app.",
    secret: false,
    clientExposed: false,
    services: ["api"],
    requiredIn: [],
    valueOrigin: "manual",
  },
  SLACK_DATA_CLIENT_SECRET: {
    group: "Ingestion",
    description:
      "Slack DATA OAuth client secret for token refresh (ingestion cron).",
    secret: true,
    clientExposed: false,
    services: ["api"],
    requiredIn: [],
    valueOrigin: "manual",
  },
  ZOOM_DATA_CLIENT_ID: {
    group: "Ingestion",
    description:
      "Zoom DATA OAuth client id for token refresh (ingestion cron). Zoom rotates the refresh token on each use.",
    secret: false,
    clientExposed: false,
    services: ["api"],
    requiredIn: [],
    valueOrigin: "manual",
  },
  ZOOM_DATA_CLIENT_SECRET: {
    group: "Ingestion",
    description:
      "Zoom DATA OAuth client secret for token refresh (ingestion cron).",
    secret: true,
    clientExposed: false,
    services: ["api"],
    requiredIn: [],
    valueOrigin: "manual",
  },
  SALESFORCE_DATA_CLIENT_ID: {
    group: "Ingestion",
    description:
      "Salesforce DATA OAuth client id for token refresh (ingestion cron).",
    secret: false,
    clientExposed: false,
    services: ["api"],
    requiredIn: [],
    valueOrigin: "manual",
  },
  SALESFORCE_DATA_CLIENT_SECRET: {
    group: "Ingestion",
    description:
      "Salesforce DATA OAuth client secret for token refresh (ingestion cron).",
    secret: true,
    clientExposed: false,
    services: ["api"],
    requiredIn: [],
    valueOrigin: "manual",
  },
  MICROSOFT_DATA_CLIENT_ID: {
    group: "Ingestion",
    description:
      "Microsoft DATA OAuth client id for token refresh (ingestion cron; MS Graph offline_access).",
    secret: false,
    clientExposed: false,
    services: ["api"],
    requiredIn: [],
    valueOrigin: "manual",
  },
  MICROSOFT_DATA_CLIENT_SECRET: {
    group: "Ingestion",
    description:
      "Microsoft DATA OAuth client secret for token refresh (ingestion cron).",
    secret: true,
    clientExposed: false,
    services: ["api"],
    requiredIn: [],
    valueOrigin: "manual",
  },

  // ── Stripe ──────────────────────────────────────────────────────────────────
  STRIPE_SECRET_KEY: {
    group: "Stripe",
    description: "Stripe secret key (sk_live in prod, sk_test in preview/dev).",
    secret: true,
    clientExposed: false,
    services: ["api", "app"],
    requiredIn: ALL,
    valueOrigin: "manual",
    placeholder: "sk_test_replace_me",
  },
  STRIPE_PUBLISHABLE_KEY: {
    group: "Stripe",
    description:
      "Stripe publishable key (pk_live in prod, pk_test in preview/dev). " +
      "Provisioning-only: no service reads it. The browser reads the " +
      "NEXT_PUBLIC_ prefixed name, and env-manager pulls this one from the " +
      "secret store so the two stay in step.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "pk_test_replace_me",
  },
  STRIPE_WEBHOOK_SECRET: {
    group: "Stripe",
    description: "Stripe webhook signing secret (whsec_).",
    secret: true,
    clientExposed: false,
    services: ["api", "app"],
    requiredIn: ALL,
    valueOrigin: "manual",
    placeholder: "whsec_replace_me",
  },
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: {
    group: "Stripe",
    description: "Browser-exposed Stripe publishable key for Stripe.js init.",
    secret: false,
    clientExposed: true,
    services: ["app"],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "pk_test_replace_me",
  },
  STRIPE_TAX_ENABLED: {
    group: "Stripe",
    description:
      "When 'true', enables Stripe Tax automatic_tax on all checkout sessions. Ships dark; flip on only after Stripe Tax is registered/active in the dashboard.",
    secret: false,
    clientExposed: false,
    services: ["api", "app"],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "false",
  },

  // ── Google Maps / Places ────────────────────────────────────────────────────
  // NEITHER VAR HAS A CONSUMER. Both were declared for a billing-address
  // autocomplete in onboarding that does not exist in apps/app: a repo-wide
  // search for either name finds only this registry and baseEnvSchema. They
  // still render into .env.example and still ask operators for values, so
  // either build the address form or delete both entries (and their
  // baseEnvSchema fields, and regenerate .env.example) — do not leave a
  // deployed secret standing for a feature nothing calls.
  //
  // If the form is built: the KEY is the only value it needs in the browser
  // (lock it down with HTTP-referrer restrictions in the Google Cloud
  // console); the SECRET is server-only and must never carry a NEXT_PUBLIC_
  // prefix, because Next.js inlines every NEXT_PUBLIC_ var into the bundle.

  // ── Billing / usage meter ────────────────────────────────────────────────────
  OXAGEN_TARGET_MARGIN: {
    group: "Billing",
    description:
      "Target blended gross margin in (0,1). Drives the usage-meter markup; keep in " +
      "sync with Stripe via `pnpm billing:stripe-sync --apply`.",
    secret: false,
    clientExposed: false,
    services: ["api", "app", "mcp"],
    requiredIn: ALL,
    valueOrigin: "static",
    staticValue: { "*": "0.65" },
  },
  OXAGEN_METER_MARKUP: {
    group: "Billing",
    description:
      "Optional pinned solved meter markup (≥1). Leave unset to derive from " +
      "OXAGEN_TARGET_MARGIN + the code config.",
    secret: false,
    clientExposed: false,
    services: ["api", "app", "mcp"],
    requiredIn: [],
    valueOrigin: "manual",
  },
  OXAGEN_USAGE_DISCOUNT_PERCENT: {
    group: "Billing",
    description:
      "Usage volume discount: percent off per OXAGEN_USAGE_DISCOUNT_INCREMENT dollars " +
      "of usage credits purchased (e.g. 3 = 3% per increment ⇒ 15% at the $250 ceiling).",
    secret: false,
    clientExposed: false,
    services: ["api", "app", "mcp", "website", "admin", "docs"],
    requiredIn: ALL,
    valueOrigin: "static",
    staticValue: { "*": "3" },
  },
  OXAGEN_USAGE_DISCOUNT_INCREMENT: {
    group: "Billing",
    description:
      "Usage volume discount: dollar increment that earns one OXAGEN_USAGE_DISCOUNT_PERCENT " +
      "step (e.g. 50 = a discount step every $50 purchased).",
    secret: false,
    clientExposed: false,
    services: ["api", "app", "mcp", "website", "admin", "docs"],
    requiredIn: ALL,
    valueOrigin: "static",
    staticValue: { "*": "50" },
  },
  OXAGEN_USAGE_DISCOUNT_CEILING_USD: {
    group: "Billing",
    description:
      "Usage volume discount: purchase amount (USD) at which the discount caps; above " +
      "this it stays flat at the max. 3% per $50 up to $250 ⇒ 15% max.",
    secret: false,
    clientExposed: false,
    services: ["api", "app", "mcp", "website", "admin", "docs"],
    requiredIn: ALL,
    valueOrigin: "static",
    staticValue: { "*": "250" },
  },

  // ── Inngest (set on app.inngest.com → Keys) ─────────────────────────────────
  INNGEST_EVENT_KEY: {
    group: "Inngest",
    description: "Inngest event key. Required in preview+production.",
    secret: true,
    clientExposed: false,
    services: ["api", "app"],
    requiredIn: DEPLOYED,
    valueOrigin: "manual",
  },
  INNGEST_SIGNING_KEY: {
    group: "Inngest",
    description: "Inngest signing key. Required in preview+production.",
    secret: true,
    clientExposed: false,
    services: ["api", "app"],
    requiredIn: DEPLOYED,
    valueOrigin: "manual",
  },
  STELLA_ENROLLMENT_SIGNING_SECRET: {
    group: "Inngest",
    description:
      "HMAC secret this deployment signs Stella enterprise-telemetry enrollments with " +
      "(create_stella_enrollment). A managed Stella install verifies the signature against its " +
      "own copy of the same secret, named by the enrollment document's verification_secret_env " +
      "— the two are distributed out of band. Unset means the capability refuses to mint " +
      "rather than issuing an enrollment no install could verify.",
    secret: true,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "generate",
  },
  STELLA_TELEMETRY_INGEST_ENDPOINTS: {
    group: "Inngest",
    description:
      "Comma-separated HTTPS ingest endpoints this deployment serves for Stella operational " +
      "telemetry. create_stella_enrollment refuses to sign an enrollment pointing anywhere else, " +
      "so an operator cannot mint a valid document aiming a fleet of installs at a third party. " +
      "Defaults to the public endpoint; plaintext entries are dropped.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "https://api.oxagen.sh/v1/telemetry/stella/operational",
  },
  TACHO_ENROLLMENT_SIGNING_SECRET: {
    group: "Inngest",
    description:
      "HMAC secret this deployment signs Tacho host enrollments with (create_tacho_enrollment). " +
      "The collector on an enrolled host verifies the enrollment document against its own copy " +
      "of the same secret, named by the document's verification_secret_env; the two are " +
      "distributed out of band. Unset means the capability refuses to enrol a host.",
    secret: true,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "",
  },
  TACHO_BUNDLE_SIGNING_PRIVATE_KEY: {
    group: "Inngest",
    description:
      "Ed25519 private key (PKCS#8 PEM, newlines as \\n) this deployment signs Tacho policy " +
      "bundles with (get_tacho_bundle). The matching public key travels to each host at " +
      "enrollment so tacho-hook verifies a cached bundle offline and fails closed on one it " +
      "cannot verify. Unset means enrollment and bundle capabilities refuse.",
    secret: true,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "",
  },
  TACHO_INGEST_ENDPOINTS: {
    group: "Inngest",
    description:
      "Comma-separated HTTPS base URLs of this deployment's Tacho machine endpoints " +
      "(the /v1/tacho prefix). create_tacho_enrollment refuses to sign an enrollment pointing " +
      "anywhere else, so an operator cannot aim a fleet of hosts at a third party. Defaults to " +
      "the public endpoint; plaintext entries are dropped.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "https://api.oxagen.sh/v1/tacho",
  },
  OXAGEN_CONTEXT_ORG: {
    group: "Context provider",
    description:
      "The organisation whose memory @oxagen/context-provider serves. Required, with no " +
      "default: the Context Graph Protocol carries no tenant, so one process serves one " +
      "workspace and which one is a deployment decision. A process started without it refuses " +
      "rather than guessing.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "acme",
  },
  OXAGEN_CONTEXT_WORKSPACE: {
    group: "Context provider",
    description:
      "The workspace whose memory @oxagen/context-provider serves. Required, with no default, " +
      "for the reason OXAGEN_CONTEXT_ORG is.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "platform",
  },
  ENGRAM_DUCKDB_PATH: {
    group: "Context provider",
    description:
      "The engram DuckDB file @oxagen/context-provider reads. Unset means an in-memory store, " +
      "so every query answers with nothing — the right answer for a misconfigured process, " +
      "rather than someone else's memory. DuckDB opens a file as a single writer, so the " +
      "process that writes this database and the process that serves it must be different.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "/var/lib/oxagen/engram.duckdb",
  },

  // ── AI providers ──────────────────────────────────────────────────────────────
  BLOB_READ_WRITE_TOKEN: {
    group: "File storage",
    description:
      "Vercel Blob read/write token. Authenticates @oxagen/storage (avatar/image uploads). Swap-point for S3/R2.",
    secret: true,
    clientExposed: false,
    services: ["app"],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "vercel_blob_rw_xxxxxxxxxxxxxxxx",
  },
  STORAGE_DRIVER: {
    group: "File storage",
    description:
      "Selects the @oxagen/storage backend: 'vercel-blob' (default, prod) or 'fs' (local/CI filesystem driver, no token needed). The swap-point for an S3/R2 driver.",
    secret: false,
    clientExposed: false,
    services: ["app"],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "vercel-blob",
  },
  STORAGE_FS_ROOT: {
    group: "File storage",
    description:
      "Root directory for the 'fs' storage driver. Only read when STORAGE_DRIVER=fs. Absolute path used as-is; a relative path is anchored at process.cwd(); unset falls back to an OS-tmp directory.",
    secret: false,
    clientExposed: false,
    services: ["app"],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "",
  },
  AI_GATEWAY_API_KEY: {
    group: "AI providers",
    description:
      "Vercel AI Gateway token — the platform's default AI auth. @oxagen/ai routes " +
      "image, embeddings and video through the gateway always, and text too unless " +
      "OXAGEN_MODEL_PROVIDER opts that deployment out, so this is required " +
      "wherever AI runs.",
    secret: true,
    clientExposed: false,
    services: ["api", "app", "mcp"],
    requiredIn: DEPLOYED,
    valueOrigin: "manual",
  },
  OXAGEN_MODEL_PROVIDER: {
    group: "AI providers",
    description:
      "Which provider serves language models: the gateway (default, and the metered " +
      "path) or 'openrouter' for a deployment that cannot reach the gateway. Never " +
      "an automatic fallback — an operator opts out explicitly, because a silent " +
      "failover would move spend to another vendor's bill and skip metering. Image, " +
      "video and embeddings stay on the gateway either way.",
    secret: false,
    clientExposed: false,
    services: ["api", "app", "mcp"],
    requiredIn: [],
    valueOrigin: "static",
    staticValue: { "*": "gateway" },
  },
  OPENROUTER_API_KEY: {
    group: "AI providers",
    description:
      "OpenRouter token for language models. Read only when " +
      "OXAGEN_MODEL_PROVIDER=openrouter; every other deployment stays valid " +
      "without it.",
    secret: true,
    clientExposed: false,
    services: ["api", "app", "mcp"],
    requiredIn: [],
    valueOrigin: "manual",
  },
  STELLA_SERVE_URL: {
    group: "Agent engine",
    description:
      "Where the Stella engine (stella-serve) listens. The in-app agent's " +
      "turns run there; every model call and tool call comes back to this " +
      "process to answer (ADR-053). Loopback on the node.",
    secret: false,
    clientExposed: false,
    services: ["api", "app"],
    requiredIn: ["production"],
    valueOrigin: "static",
    staticValue: {
      development: "http://127.0.0.1:4200",
      preview: "http://127.0.0.1:4200",
      production: "http://127.0.0.1:4200",
    },
  },
  STELLA_SERVE_TOKEN: {
    group: "Agent engine",
    description:
      "Bearer token the Stella engine was started with. The same value the " +
      "engine's own container reads under its prefix; without it the " +
      "assistant reports the engine as unavailable.",
    secret: true,
    clientExposed: false,
    services: ["api", "app"],
    requiredIn: ["production"],
    valueOrigin: "manual",
  },
  ANTHROPIC_API_KEY: {
    group: "AI providers",
    description:
      "CLI-only BYOK fallback: when no AI_GATEWAY_API_KEY exists anywhere, the CLI " +
      "runs anthropic/* models directly against the Anthropic API with this key " +
      "(other vendors and embeddings stay unavailable). The gateway key always wins " +
      "when both are set. Never read by deployed services — platform AI is " +
      "gateway-only.",
    secret: true,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
  },
  OXAGEN_LLM_FAST: {
    group: "AI providers",
    description:
      'Fast text tier ("Oxagen Fast") — the gateway model id @oxagen/ai resolves for ' +
      "the fast tier. The ask-page default.",
    secret: false,
    clientExposed: false,
    services: ["api", "app", "mcp"],
    requiredIn: [],
    valueOrigin: "static",
    staticValue: { "*": "anthropic/claude-haiku-4.5" },
  },
  OXAGEN_LLM_BALANCED: {
    group: "AI providers",
    description:
      'Balanced text tier ("Oxagen Balanced") — gateway model id for the balanced tier.',
    secret: false,
    clientExposed: false,
    services: ["api", "app", "mcp"],
    requiredIn: [],
    valueOrigin: "static",
    staticValue: { "*": "anthropic/claude-sonnet-5" },
  },
  OXAGEN_LLM_PRECISE: {
    group: "AI providers",
    description:
      'Precise text tier ("Oxagen Precise") — gateway model id for the precise tier.',
    secret: false,
    clientExposed: false,
    services: ["api", "app", "mcp"],
    requiredIn: [],
    valueOrigin: "static",
    staticValue: { "*": "anthropic/claude-fable-5" },
  },

  // ── Email (transactional — @oxagen/notifications SMTP transport) ─────────────
  // SMTP is the vendor-neutral seam: Resend today, any SMTP provider tomorrow
  // with an env-only swap. Optional in the schema; the transport enforces
  // presence at first send. Pushed to every app surface so any can send mail.
  SMTP_HOST: {
    group: "Email",
    description: "SMTP server host (Resend: smtp.resend.com).",
    secret: false,
    clientExposed: false,
    services: ["api", "app", "mcp", "website", "admin"],
    requiredIn: [],
    valueOrigin: "static",
    staticValue: { "*": "smtp.resend.com" },
  },
  SMTP_PORT: {
    group: "Email",
    description:
      "SMTP port. 465 = implicit TLS; 587 = STARTTLS (TLS enforced).",
    secret: false,
    clientExposed: false,
    services: ["api", "app", "mcp", "website", "admin"],
    requiredIn: [],
    valueOrigin: "static",
    staticValue: { "*": "587" },
  },
  SMTP_USERNAME: {
    group: "Email",
    description: 'SMTP username (Resend: the literal "resend").',
    secret: false,
    clientExposed: false,
    services: ["api", "app", "mcp", "website", "admin"],
    requiredIn: [],
    valueOrigin: "static",
    staticValue: { "*": "resend" },
  },
  SMTP_PASSWORD: {
    group: "Email",
    description: "SMTP password — for Resend this is an API key (re_…).",
    secret: true,
    clientExposed: false,
    services: ["api", "app", "mcp", "website", "admin"],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "re_xxxxxxxxxxxxxxxx",
  },
  SMTP_FROM_EMAIL: {
    group: "Email",
    description:
      "Default sender address. Its domain must be verified at the provider.",
    secret: false,
    clientExposed: false,
    services: ["api", "app", "mcp", "website", "admin"],
    requiredIn: [],
    valueOrigin: "static",
    staticValue: { "*": "noreply@notifications.oxagen.sh" },
  },
  SMTP_FROM_NAME: {
    group: "Email",
    description: "Default sender display name.",
    secret: false,
    clientExposed: false,
    services: ["api", "app", "mcp", "website", "admin"],
    requiredIn: [],
    valueOrigin: "static",
    staticValue: { "*": "Oxagen (DO NOT REPLY)" },
  },

  // ── Linear (capability provenance) ───────────────────────────────────────────
  LINEAR_API_KEY: {
    group: "Linear",
    description:
      "Linear API key (tooling/provenance; not read by deployed apps).",
    secret: true,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
  },
  LINEAR_PROJECT_ID: {
    group: "Linear",
    description: "Linear project id for the oxagen-v2 project (tooling-only).",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "static",
    staticValue: { "*": "oxagen-v2-355ea6b2a3f7" },
  },

  // ── Public URLs ───────────────────────────────────────────────────────────────
  NEXT_PUBLIC_APP_URL: {
    group: "Public URLs",
    description: "Public app origin (browser-exposed).",
    secret: false,
    clientExposed: true,
    services: ["app", "website"],
    requiredIn: ALL,
    valueOrigin: "static",
    staticValue: {
      development: "http://localhost:3000",
      production: APP_PROD_URL,
    },
  },
  NEXT_PUBLIC_API_URL: {
    group: "Public URLs",
    description: "Public api origin (browser-exposed).",
    secret: false,
    clientExposed: true,
    services: ["app", "website"],
    requiredIn: ALL,
    valueOrigin: "static",
    staticValue: {
      development: "http://localhost:4000",
      production: API_PROD_URL,
    },
  },
  APP_URL: {
    group: "Public URLs",
    description:
      "Server-side app origin used to build plugin OAuth authorize/callback URLs " +
      "(falls back to NEXT_PUBLIC_APP_URL). Not browser-exposed.",
    secret: false,
    clientExposed: false,
    services: ["api", "app", "mcp"],
    requiredIn: [],
    valueOrigin: "static",
    staticValue: {
      development: "http://localhost:3000",
      production: APP_PROD_URL,
    },
  },
  MARKETING_URL: {
    group: "Public URLs",
    description:
      "Public marketing website origin (oxagen.sh). The /v1/cms/* lead routes " +
      "use it to build the emailed reader link and CORS allows it as a " +
      "cross-origin caller. Not browser-exposed.",
    secret: false,
    clientExposed: false,
    services: ["api"],
    requiredIn: [],
    valueOrigin: "static",
    staticValue: {
      development: "http://localhost:8080",
      production: MARKETING_PROD_URL,
    },
  },
  MCP_URL: {
    group: "Public URLs",
    description:
      "MCP server origin used to build install instructions and client connections.",
    secret: false,
    clientExposed: false,
    services: ["api", "app", "mcp"],
    requiredIn: [],
    valueOrigin: "static",
    staticValue: {
      development: "http://localhost:4100",
      production: MCP_PROD_URL,
    },
  },
  NEXT_PUBLIC_DOCS_URL: {
    group: "Public URLs",
    description:
      "Optional override for the docs site origin (browser-exposed). When unset, " +
      "apps/app resolves the correct URL per environment automatically (dev → " +
      "http://localhost:3300; prod → https://docs.oxagen.sh, per " +
      "apps/app/src/lib/docs-url.ts). Set only to test a custom docs " +
      "deployment. Validated as an optional URL by baseEnvSchema.",
    secret: false,
    clientExposed: true,
    services: ["app"],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "",
  },
  NEXT_PUBLIC_CHAT_UX_V2: {
    group: "Public URLs",
    description:
      "chat_ux_v2 feature flag (apps/app chat UX overhaul, browser-exposed). " +
      '"1" enables the new session-settings chat surface environment-wide; ' +
      "unset/anything else = off. A per-browser cookie override " +
      "(?chat_ux_v2=1|0) wins over this default. Validated as an optional " +
      '"0"|"1" enum by baseEnvSchema.',
    secret: false,
    clientExposed: true,
    services: ["app"],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "",
  },

  // ── Security / RLS enforcement ───────────────────────────────────────────────
  TENANT_RLS_ENFORCEMENT_ENABLED: {
    group: "Security",
    description:
      "When true, Postgres RLS policies filter by org/workspace. Fail-closed: " +
      "when UNSET it defaults ON in production (NODE_ENV/VERCEL_ENV=production) " +
      "and OFF in dev/test/preview. A production process refuses to boot if this " +
      "is forced to false (assertRlsEnforcedInProduction). Local dev override: " +
      "set false in .env.local only if seeding/migration scripts need to bypass " +
      "RLS; revert before running app code against the DB.",
    secret: false,
    clientExposed: false,
    services: ["api", "app", "mcp"],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "true",
  },

  // ── Observability / feature flags ───────────────────────────────────────────
  LOG_LEVEL: {
    group: "Observability",
    description: "Pino log level for service loggers.",
    secret: false,
    clientExposed: false,
    services: ["api", "app", "mcp"],
    requiredIn: [],
    valueOrigin: "static",
    staticValue: { development: "debug", preview: "info", production: "info" },
  },
  KNOWLEDGE_GRAPH_ENABLED: {
    group: "Observability",
    description:
      'Feature flag — set "false" to disable the Neo4j knowledge-graph writes.',
    secret: false,
    clientExposed: false,
    services: ["api", "app", "mcp"],
    requiredIn: [],
    valueOrigin: "static",
    staticValue: { "*": "true" },
  },
  MCP_PORT: {
    group: "Observability",
    description: "HTTP port for the xmcp server.",
    secret: false,
    clientExposed: false,
    services: ["mcp"],
    requiredIn: [],
    valueOrigin: "manual",
  },

  // ── Release / build metadata ────────────────────────────────────────────────
  PLATFORM_VERSION: {
    group: "Release / build metadata",
    description:
      "Platform version string surfaced by @oxagen/config platformVersion(). Written by " +
      "`pnpm release:*` and synced to every oxagen-v2-* Vercel project. Declared in " +
      "turbo.json globalEnv so a version change busts the build cache. LOCAL: leave unset → " +
      "falls back to package.json version. PROD/PREVIEW: the released semver. NOTE: read via " +
      "raw process.env in @oxagen/config — not yet in baseEnvSchema (tracked).",
    secret: false,
    clientExposed: false,
    services: ["api", "app", "mcp"],
    requiredIn: [],
    valueOrigin: "manual",
  },

  // ── Testing / e2e (test lanes only; never pushed to deployed projects) ───────
  PLAYWRIGHT_BASE_URL: {
    group: "Testing / e2e",
    description:
      "Base URL Playwright drives in apps/app e2e (apps/app/playwright.config.ts). LOCAL: unset → " +
      "defaults to http://localhost:3000. CI: the booted next server URL. NOTE: read via raw " +
      "process.env — not in baseEnvSchema (test-only).",
    secret: false,
    clientExposed: false,
    services: ["app"],
    requiredIn: [],
    valueOrigin: "manual",
  },
  E2E_TEST: {
    group: "Testing / e2e",
    description:
      'Set "true" in the vitest test lanes (declared in turbo.json test:unit/test:coverage env) ' +
      "so app code can branch to test-only behavior. Not for dev/preview/prod. NOTE: read via raw " +
      "process.env — not in baseEnvSchema (test-only).",
    secret: false,
    clientExposed: false,
    services: ["app"],
    requiredIn: [],
    valueOrigin: "manual",
  },
  OXAGEN_LOCAL_DEV: {
    group: "Testing / e2e",
    description:
      'Set to "1" by tools/scripts/dev.ts for the local dev stack. Consumed by packages/auth ' +
      "to make local-env detection deterministic instead of racing NODE_ENV at module-load time. " +
      "Ignored on real Vercel deployments (VERCEL=1 guards it). NOTE: read via raw " +
      "process.env — not in baseEnvSchema (dev-tooling only).",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
  },

  // ── env-manager tooling (operator/local-only; never pushed to app projects) ──
  VERCEL_TOKEN: {
    group: "env-manager tooling",
    description:
      "Vercel API token (admin) the env-manager uses to read/write project env vars.",
    secret: true,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
  },
  VERCEL_TEAM_ID: {
    group: "env-manager tooling",
    description: "Vercel team id (defaults to the oxagen team).",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
  },
  VERCEL_TEAM_SLUG: {
    group: "env-manager tooling",
    description:
      'Vercel team slug for `pnpm env:pull` --scope (e.g. "oxagen"). Optional — when unset, ' +
      "the CLI resolves the team from each project's linked .vercel/project.json.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "oxagen",
  },
  ENV_MANAGER_PORT: {
    group: "env-manager tooling",
    description: "Local port for the env-manager web UI.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "static",
    staticValue: { "*": "7799" },
  },

  // ── Security / audit ────────────────────────────────────────────────────────
  AUDIT_EXPORT_SIGNING_SECRET: {
    group: "Security",
    description:
      "HMAC-SHA256 secret for signing audit-log export tokens, so exported files " +
      "can be verified as untampered. OPTIONAL: baseEnvSchema declares it " +
      "`.optional()` and the audit export route falls back to " +
      "BETTER_AUTH_SECRET when it is unset. Setting a dedicated value changes " +
      "the signing key and invalidates outstanding export download URLs. " +
      "Generate with `openssl rand -base64 32`.",
    secret: true,
    clientExposed: false,
    services: ["app"],
    // Was ["production"], which contradicted the schema and the route. The
    // build-environment resolver enforces this field, so the contradiction
    // stopped the first app deploy that ever reached it — a registry claiming
    // a variable is required is a promise the running code has to keep.
    requiredIn: [],
    valueOrigin: "generate",
    placeholder: "",
  },

  SERVER_ACTIONS_ALLOWED_ORIGINS: {
    group: "Security",
    description:
      "Extra hosts allowed to POST a Next server action to apps/app, comma-separated. " +
      "Next rejects a server action whose Origin is not the deployment's own host, so a " +
      "custom domain in front of the app has to be named here or every mutation 403s.",
    secret: false,
    clientExposed: false,
    services: ["app"],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "app.oxagen.sh",
  },

  // ── CLI / tooling ────────────────────────────────────────────────────────────
  OXAGEN_API_TOKEN: {
    group: "CLI",
    description:
      "API token used by the CLI to authenticate requests; falls back to the value stored in ~/.oxagen/config.json.",
    secret: true,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
  },
  OXAGEN_ORG_ID: {
    group: "CLI",
    description:
      "Default org slug for CLI commands; falls back to the value stored in ~/.oxagen/config.json.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
  },
  OXAGEN_WORKSPACE_ID: {
    group: "CLI",
    description:
      "Default workspace slug for CLI commands; falls back to the value stored in ~/.oxagen/config.json.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
  },
  OXAGEN_API_URL: {
    group: "CLI",
    description:
      "Base URL for the Oxagen REST API, consumed by the CLI. Falls back to the " +
      "default production API URL when unset.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "static",
    staticValue: {
      development: "http://localhost:4000",
      production: "https://api.oxagen.sh",
    },
  },
  OXAGEN_APP_URL: {
    group: "CLI",
    description:
      "Base URL for the Oxagen web app, where `oxagen login` opens the browser " +
      "authorize page. Falls back to the default production app URL when unset.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "static",
    staticValue: {
      development: "http://localhost:3000",
      production: "https://app.oxagen.sh",
    },
  },
  DO_NOT_TRACK: {
    group: "CLI",
    description:
      "Cross-tool opt-out convention (https://consoledonottrack.com): set to '1' to disable CLI " +
      "usage telemetry. Checked before OXAGEN_TELEMETRY and the persisted telemetry.enabled config.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "1",
  },
  OXAGEN_TELEMETRY: {
    group: "CLI",
    description:
      "Set to '0' to disable CLI usage telemetry for this invocation (equivalent to `oxagen " +
      "telemetry off`). DO_NOT_TRACK=1 also disables it and takes precedence.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "0",
  },
  OXAGEN_DEBUG: {
    group: "CLI",
    description:
      "When set, the CLI prints extra diagnostics (e.g. context-engine memory open failures) to stderr.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
  },
  OXAGEN_ALLOW_STDIO_MCP: {
    group: "CLI",
    description:
      "Set to '1' or 'true' to allow stdio-transport MCP servers to be SPAWNED as child " +
      "processes from workspace file-mcp plugin configs (packages/agent file-mcp.ts). " +
      "Spawning is OFF by default because a workspace-scoped config could otherwise " +
      "execute arbitrary commands on the API host — enable only for a trusted " +
      "local/CLI runtime, never on shared server deployments. HTTP MCP transports are " +
      "unaffected and always processed.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
  },
  INGESTION_CRYPTO_PROVIDER: {
    group: "Ingestion",
    description:
      "Credential encryption backend for ingestion: 'env' (AES-256-GCM via INGESTION_ENCRYPTION_KEY) or 'kms' (AWS KMS).",
    secret: false,
    clientExposed: false,
    services: ["api"],
    requiredIn: [],
    valueOrigin: "static",
    staticValue: { development: "env", preview: "env", production: "env" },
  },
  INGESTION_ENCRYPTION_KEY: {
    group: "Ingestion",
    description:
      "Base64-encoded 32-byte master key for AES-256-GCM credential encryption (INGESTION_CRYPTO_PROVIDER=env).",
    secret: true,
    clientExposed: false,
    services: ["api"],
    requiredIn: ["preview", "production"],
    valueOrigin: "manual",
  },
  AWS_KMS_INGESTION_KEY_ARN: {
    group: "Ingestion",
    description:
      "AWS KMS key ARN for credential encryption (INGESTION_CRYPTO_PROVIDER=kms).",
    secret: false,
    clientExposed: false,
    services: ["api"],
    requiredIn: [],
    valueOrigin: "manual",
  },
  PRIVACY_ERASURE_GRACE_DAYS: {
    group: "Privacy",
    description:
      "Grace period in days before a hard-delete erasure job runs (GDPR Art.17). Set to 0 for immediate erasure in test envs.",
    secret: false,
    clientExposed: false,
    services: ["api"],
    requiredIn: [],
    valueOrigin: "static",
    staticValue: { development: "0", preview: "0", production: "30" },
  },

  // ── Operator scripts, build flags and deploy tooling ─────────────────────
  BLOG_DRAFTS: {
    group: "Operator scripts",
    description:
      "Set to 1 to include draft posts when building the static research blog " +
      "(apps/web/scripts/build.mjs). Unset in every deploy, so drafts never ship.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "1",
  },
  WEB_PORT: {
    group: "Operator scripts",
    description:
      "Port for the apps/web static dev server (apps/web/scripts/dev.mjs). " +
      "Defaults to 5500; local convenience only, never read by a deploy.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "5500",
  },
  STANDALONE: {
    group: "Operator scripts",
    description:
      "Set to 1 to build apps/app or apps/docs with Next's standalone output. " +
      "tools/scripts/package-for-node.sh sets it for the self-hosted node bundle; " +
      "Vercel builds leave it unset and get the default output.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "1",
  },
  WRITE_MANIFEST_IMAGE: {
    group: "Operator scripts",
    description:
      "Container image the packaged node bundle's run manifest names. " +
      "Defaults to node:22-alpine.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "node:22-alpine",
  },
  NPM_TOKEN: {
    group: "Operator scripts",
    description:
      "npm automation token used to publish the CLI package. Unset skips the npm " +
      "publish step of `pnpm release` rather than failing it.",
    secret: true,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
  },

  OXAGEN_INSTALL_BASE: {
    group: "Operator scripts",
    description:
      "Base URL the published install.sh downloads CLI release archives from. " +
      "Set it to install from a staging bucket instead of cli.oxagen.sh.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "https://cli.oxagen.sh/releases/latest",
  },
  OXAGEN_INSTALL_DIR: {
    group: "Operator scripts",
    description:
      "Directory install.sh puts the oxagen binary in. Defaults to ~/.local/bin.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "$HOME/.local/bin",
  },

  ADMIN_DATABASE_URL: {
    group: "Operator scripts",
    description:
      "Superuser Postgres connection used by provision-rls-role.ts to create the " +
      "least-privilege app role. Kept separate from DATABASE_URL so the provisioning " +
      "step cannot silently run through the restricted connection it is about to create.",
    secret: true,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
  },
  PRODUCTION_DATABASE_URL: {
    group: "Operator scripts",
    description:
      "Migration connection for tools/scripts/vercel-migrate.sh, holding a role that may " +
      "run DDL against pre-existing schemas. The app role may only CREATE in schemas it " +
      "owns, so migrating through DATABASE_URL fails 42501 on billing and friends.",
    secret: true,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
  },
  DB_MIGRATE_STORES: {
    group: "Operator scripts",
    description:
      "Comma-separated stores `pnpm db:migrate` should migrate. Defaults to " +
      "clickhouse,neo4j — Postgres is Atlas's job and is deliberately not in the list.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "clickhouse,neo4j",
  },
  PGSUPERUSER: {
    group: "Operator scripts",
    description:
      "Superuser on the cluster tools/scripts/rds-sim-check.sh simulates RDS against. " +
      "The script refuses to run without it.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
  },
  PGSUPERPASS: {
    group: "Operator scripts",
    description: "Password for PGSUPERUSER.",
    secret: true,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
  },
  PRODUCTION_ANALYTICS_URL: {
    group: "Operator scripts",
    description:
      "Production ClickHouse endpoint tools/scripts/backfill-claude-telemetry.ts writes " +
      "backfilled session rows to.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
  },
  PRODUCTION_ANALYTICS_USER: {
    group: "Operator scripts",
    description: "Username for PRODUCTION_ANALYTICS_URL.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
  },
  PRODUCTION_ANALYTICS_PASSWORD: {
    group: "Operator scripts",
    description: "Password for PRODUCTION_ANALYTICS_USER.",
    secret: true,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
  },
  USER_EMAIL: {
    group: "Operator scripts",
    description:
      "Email stamped on rows the Claude telemetry backfill writes, so a backfilled " +
      "session is attributable to whoever ran the script.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
  },
  INNGEST_DEV: {
    group: "Operator scripts",
    description:
      "Set to 1 to point the Inngest SDK at a local dev server instead of Inngest Cloud. " +
      "tools/scripts/inngest-dev.ts sets it for every child turbo spawns.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "1",
  },
  GCP_PROJECT: {
    group: "Operator scripts",
    description:
      "Google Cloud project the env-manager pulls Secret Manager secrets from. " +
      "Defaults to oxagen-490023.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "oxagen-490023",
  },
  CONTEXT_GRAPH_PROTOCOL_DIR: {
    group: "Operator scripts",
    description:
      "Path to a local context-graph-protocol checkout. check-contextgraph-fixtures.ts " +
      "verifies the vendored profile against it when set.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
  },
  MAIN_VERIFIED_WINDOW: {
    group: "Operator scripts",
    description:
      "How many recent commits on main check-main-verified.mjs asks about. Defaults to 10.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "10",
  },
  SCR_OWNER: {
    group: "Operator scripts",
    description:
      "GitHub owner whose repos the SCR corpus check reads. Defaults to macanderson.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "macanderson",
  },
  OXAGEN_HOUSE_BRAND: {
    group: "Operator scripts",
    description:
      "Path to the oxagen-house-brand checkout sync-brand-assets.mjs copies marks from. " +
      "Defaults to a sibling directory of this repository.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
  },
  VISION_GATE_MODEL: {
    group: "Operator scripts",
    description: "Model the vision gate judges a diff with.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
  },
  VISION_GATE_BASE: {
    group: "Operator scripts",
    description: "Ref the vision gate diffs against. Defaults to origin/main.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "origin/main",
  },
  VISION_GATE_STRICT: {
    group: "Operator scripts",
    description:
      "Set to 1 to make a drifts verdict fail the vision gate instead of only printing it.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "1",
  },

  // ── Infrastructure (read by infra/ scripts and provisioned Lambdas) ────────
  NODE_NAME: {
    group: "Infrastructure",
    description:
      "Name tag of the EC2 instance the infra/tools scripts target. Defaults to oxagen-app.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "oxagen-app",
  },
  DATA_NODE_NAME: {
    group: "Infrastructure",
    description:
      "Name tag of the data-plane EC2 instance the DB-client tunnel scripts target. " +
      "Defaults to oxagen-data.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "oxagen-data",
  },
  AURORA_ENDPOINT: {
    group: "Infrastructure",
    description:
      "Aurora writer endpoint for run-db-migrations.sh. Set it to skip the AWS lookup " +
      "the script otherwise does.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
  },
  AURORA_PORT: {
    group: "Infrastructure",
    description: "Port for AURORA_ENDPOINT. Defaults to 5432.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "5432",
  },
  EVENT_BUS_NAME: {
    group: "Infrastructure",
    description:
      "EventBridge bus the log-event-publisher Lambda puts events on. The stack sets it " +
      "on the function; the handler refuses to import without it.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
  },
};

// ─── Derivations (the single place every surface reads from) ─────────────────

const SCHEMA_KEYS: ReadonlySet<string> = new Set(
  Object.keys(baseEnvSchema.shape),
);

/** True iff the variable is enforced by the Zod `baseEnvSchema` runtime validator. */
export function isValidated(key: string): boolean {
  return SCHEMA_KEYS.has(key);
}

/** Every variable name the registry knows about. */
export function registryKeys(): string[] {
  return Object.keys(ENV_REGISTRY);
}

/** Keys a given service needs present in a given environment (the gap-detector contract). */
export function requiredKeysFor(service: ServiceName, env: EnvName): string[] {
  return Object.entries(ENV_REGISTRY)
    .filter(
      ([, m]) => m.services.includes(service) && m.requiredIn.includes(env),
    )
    .map(([k]) => k);
}

/** All client-exposed (`NEXT_PUBLIC_`) keys. */
export function clientKeys(): string[] {
  return Object.entries(ENV_REGISTRY)
    .filter(([, m]) => m.clientExposed)
    .map(([k]) => k);
}

/** All keys stored encrypted on Vercel. */
export function secretKeys(): string[] {
  return Object.entries(ENV_REGISTRY)
    .filter(([, m]) => m.secret)
    .map(([k]) => k);
}

/** The static value for a key in an env, if one is defined (`"*"` = shared). */
export function staticValueFor(key: string, env: EnvName): string | undefined {
  const sv = ENV_REGISTRY[key]?.staticValue;
  if (!sv) return undefined;
  return sv[env] ?? sv["*"];
}

/**
 * Render the canonical `.env.example` from the registry. Deterministic (stable
 * group + insertion order) so CI can assert the committed file matches via diff.
 */
export function renderEnvExample(): string {
  const lines: string[] = [
    "# Oxagen environment contract — GENERATED from packages/config/src/registry.ts.",
    "# Do not edit by hand: run `pnpm env:check --write` to regenerate.",
    "# Copy to .env.local (gitignored) and fill values. NOTE markers flag vars not",
    "# yet validated by baseEnvSchema (tracked in Linear).",
    "",
  ];
  let group: string | null = null;
  for (const [key, meta] of Object.entries(ENV_REGISTRY)) {
    if (meta.group !== group) {
      group = meta.group;
      const bar = "─".repeat(Math.max(1, 74 - group.length));
      lines.push(`# ── ${group} ${bar}`);
    }
    const flags: string[] = [];
    if (!isValidated(key)) flags.push("not-in-schema");
    if (meta.secret) flags.push("secret");
    if (meta.requiredIn.length > 0)
      flags.push(`required:${meta.requiredIn.join("/")}`);
    else flags.push("optional");
    lines.push(
      `# ${meta.description}${flags.length ? `  [${flags.join(", ")}]` : ""}`,
    );
    const value = staticValueFor(key, "development") ?? meta.placeholder ?? "";
    lines.push(`${key}=${value}`);
    lines.push("");
  }
  return lines.join("\n").replace(/\n+$/, "\n");
}

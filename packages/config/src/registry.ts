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
  RATE_LIMIT_AGENT_EXEC_PER_MIN: {
    group: "Rate limiting",
    description:
      "Max agent-execution requests per minute per workspace (fallback: per org, then " +
      "per IP) — code-exec / compose / sandbox ops / background-task start / A2A RPC. " +
      "Optional — defaults to 30 in packages/config/src/env.ts.",
    secret: false,
    clientExposed: false,
    services: ["api"],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "30",
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
  GITHUB_DATA_CLIENT_ID: {
    group: "OAuth providers",
    description:
      "GitHub DATA OAuth client id (repo-ingestion scopes; future connection).",
    secret: false,
    clientExposed: false,
    services: ["api", "app"],
    requiredIn: [],
    valueOrigin: "manual",
  },
  GITHUB_DATA_CLIENT_SECRET: {
    group: "OAuth providers",
    description: "GitHub DATA OAuth client secret.",
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
      "Stripe publishable key (pk_live in prod, pk_test in preview/dev).",
    secret: false,
    clientExposed: false,
    services: ["api", "app"],
    requiredIn: ALL,
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
  // Used by the onboarding billing-address autocomplete. The KEY is the only
  // value the feature needs in the browser (lock it down with HTTP-referrer
  // restrictions in the Google Cloud console). The SECRET var has no current
  // consumer in the codebase; it is a plain server-only var (no NEXT_PUBLIC_
  // prefix) — renamed from NEXT_PUBLIC_GOOGLE_MAPS_API_SECRET specifically so
  // Next.js would stop inlining a signing secret into the client bundle.
  NEXT_PUBLIC_GOOGLE_MAPS_API_KEY: {
    group: "Google Maps",
    description:
      "Browser-exposed Google Maps / Places API key powering billing-address autocomplete " +
      "in onboarding. Restrict to HTTP referrers in the Google Cloud console.",
    secret: false,
    clientExposed: true,
    services: ["app"],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "",
  },
  GOOGLE_MAPS_URL_SIGNING_SECRET: {
    group: "Google Maps",
    description:
      "Google Maps URL-signing secret. Server-side only — must never be inlined into the " +
      "browser bundle. Renamed from NEXT_PUBLIC_GOOGLE_MAPS_API_SECRET (which would have " +
      "caused Next.js to expose it client-side). Consumed server-side only when URL signing " +
      "is enabled.",
    secret: true,
    clientExposed: false,
    services: ["api", "app"],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "",
  },

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
  OXAGEN_ENGINE: {
    group: "Inngest",
    description:
      "Which engine runs an agent turn (agent-engine v2 Phase C — " +
      "docs/specs/agent-engine-v2/stella-adoption-plan.md): `ts` for the TypeScript step loop, " +
      "`stella` to hand the turn to a `stella-serve` sidecar over loopback. Defaults to `ts`. " +
      "A run's own RunSpec v2 enginePolicy.requested_engine wins over this, which is what makes " +
      "a shadow slice a property of the run rather than of the deployment. An unrecognised " +
      "value fails the process at boot rather than silently running `ts`.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "ts",
  },
  STELLA_SERVE_BIN: {
    group: "Inngest",
    description:
      "Absolute path to the `stella-serve` binary the Stella engine path boots (agent-engine v2 " +
      "Phase C). Falls back to `stella-serve` on PATH. Needed on a worker running " +
      "OXAGEN_ENGINE=stella — there is deliberately no fallback to the TS engine when the " +
      "binary is missing, so a turn that asked for Stella fails rather than quietly running the " +
      "other one. One sidecar is spawned per worker slot, bound to loopback with a per-process " +
      "token.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "/usr/local/bin/stella-serve",
  },
  OXAGEN_WORKER_CONCURRENCY: {
    group: "Inngest",
    description:
      "Simultaneous durable runs one @oxagen/agent-worker process drives (agent-engine v2 " +
      "Phase 2c — docs/specs/agent-engine-v2/plan.md 'Phase 2 — Durable runs'). Grouped with " +
      "Inngest: the worker pool claims runs via FOR UPDATE SKIP LOCKED + lease heartbeat while " +
      "Inngest keeps dispatch/cancelOn/lease-sweep — the two jointly implement the durable-run " +
      "system. Defaults to 2 (createAgentWorker's WorkerOptions.concurrency default) when unset " +
      "or not a positive integer.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "2",
  },
  OXAGEN_WORKER_ID: {
    group: "Inngest",
    description:
      "Claim/lease owner identity for one @oxagen/agent-worker process (agent-engine v2 Phase " +
      "2c). Stamped as `claimed_by` on the durable-run row so a crashed worker's runs are " +
      "identifiable and reclaimable. Defaults to `${os.hostname()}:${process.pid}` when unset.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "worker-1:12345",
  },
  OXAGEN_RUN_V2_CLAIMS_ENABLED: {
    group: "Inngest",
    description:
      'Feature flag — set "1"/"true" to let one @oxagen/agent-worker process claim fenced ' +
      "RunSpecV2 attempts (docs/specs/run-evidence-ingress/02-run-attempt-foundation-plan.md). " +
      "OFF by default, and PR 1A reads it nowhere: main.ts does not pass `attempts` to " +
      "createAgentWorker, and that omission is the real gate — this var documents the " +
      "operational contract PR 1B wires it to. Enabling v2 execution makes every attempt seal " +
      "mint a one-shot finalization grant (afg_) and a durable obligation, so it MUST stay off " +
      "until PR 2B deploys finalization consumption, the evidence ledger, and the obligation " +
      "worker — otherwise each seal creates an obligation no running process can satisfy. " +
      "Turning it on does NOT stop v1 claims; the worker tries v2 first and falls back, so " +
      "already-enqueued legacy work keeps draining either way.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "static",
    staticValue: { "*": "false" },
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
  OXAGEN_LLM_IMAGE_BASIC: {
    group: "AI providers",
    description:
      'Basic image tier ("Oxagen Basic") — default gateway image model for composer ' +
      "image generation.",
    secret: false,
    clientExposed: false,
    services: ["api", "app", "mcp"],
    requiredIn: [],
    valueOrigin: "static",
    staticValue: { "*": "openai/gpt-image-1" },
  },
  OXAGEN_LLM_IMAGE_ADVANCED: {
    group: "AI providers",
    description:
      'Advanced image tier ("Oxagen Advanced") — high-fidelity gateway image model.',
    secret: false,
    clientExposed: false,
    services: ["api", "app", "mcp"],
    requiredIn: [],
    valueOrigin: "static",
    staticValue: { "*": "bfl/flux-2-max" },
  },
  OXAGEN_LLM_VIDEO_BASIC: {
    group: "AI providers",
    description:
      'Basic video tier ("Oxagen Basic") — default gateway video model for composer ' +
      "video generation (pipeline stub).",
    secret: false,
    clientExposed: false,
    services: ["api", "app", "mcp"],
    requiredIn: [],
    valueOrigin: "static",
    staticValue: { "*": "google/veo-3.0-fast-generate-001" },
  },
  OXAGEN_LLM_VIDEO_ADVANCED: {
    group: "AI providers",
    description:
      'Advanced video tier ("Oxagen Advanced") — high-fidelity gateway video model.',
    secret: false,
    clientExposed: false,
    services: ["api", "app", "mcp"],
    requiredIn: [],
    valueOrigin: "static",
    staticValue: { "*": "google/veo-3.0-generate-001" },
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
  A2A_PUBLIC_URL: {
    group: "Public URLs",
    description:
      "Public origin advertised in the A2A (Agent2Agent) protocol Agent Card's " +
      "service endpoint and the /.well-known/agent-card.json URL. Optional — the " +
      "A2A routes derive the origin from the live request; this only overrides the " +
      "default for out-of-band card reads (MCP/CLI). Falls back to the API origin.",
    secret: false,
    clientExposed: false,
    services: ["api", "mcp"],
    requiredIn: [],
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

  // ── Sandbox runtime ───────────────────────────────────────────────────────────
  SANDBOX_ENABLED: {
    group: "Sandbox",
    description: "Whether to execute tool calls in an isolated sandbox.",
    secret: false,
    clientExposed: false,
    services: ["api", "app", "mcp"],
    requiredIn: [],
    valueOrigin: "static",
    staticValue: { development: "false", preview: "true", production: "true" },
  },
  SANDBOX_DRIVER: {
    group: "Sandbox",
    description: "Sandbox backend: modal | docker | vercel.",
    secret: false,
    clientExposed: false,
    services: ["api", "app", "mcp"],
    requiredIn: [],
    valueOrigin: "static",
    staticValue: {
      development: "docker",
      preview: "vercel",
      production: "vercel",
    },
  },
  MODAL_RUNNER_URL: {
    group: "Sandbox",
    description: "Modal sandboxed runner URL (SANDBOX_DRIVER=modal).",
    secret: false,
    clientExposed: false,
    services: ["api", "app", "mcp"],
    requiredIn: [],
    valueOrigin: "manual",
  },
  MODAL_RUNNER_TOKEN: {
    group: "Sandbox",
    description: "Modal sandboxed runner token (SANDBOX_DRIVER=modal).",
    secret: true,
    clientExposed: false,
    services: ["api", "app", "mcp"],
    requiredIn: [],
    valueOrigin: "manual",
  },
  VERCEL_SANDBOX_TOKEN: {
    group: "Sandbox",
    description:
      "Vercel Sandbox token (SANDBOX_DRIVER=vercel; OIDC auto-resolves on Vercel).",
    secret: true,
    clientExposed: false,
    services: ["api", "app", "mcp"],
    requiredIn: [],
    valueOrigin: "manual",
  },
  VERCEL_SANDBOX_TEAM_ID: {
    group: "Sandbox",
    description: "Vercel Sandbox team id (SANDBOX_DRIVER=vercel).",
    secret: false,
    clientExposed: false,
    services: ["api", "app", "mcp"],
    requiredIn: [],
    valueOrigin: "manual",
  },
  VERCEL_SANDBOX_PROJECT_ID: {
    group: "Sandbox",
    description: "Vercel Sandbox project id (SANDBOX_DRIVER=vercel).",
    secret: false,
    clientExposed: false,
    services: ["api", "app", "mcp"],
    requiredIn: [],
    valueOrigin: "manual",
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
  OXAGEN_DURABLE_RUNS: {
    group: "Observability",
    description:
      'Feature flag — set "1" or "true" to mount the durable-run API (POST /runs, ' +
      "GET /runs/:publicId, GET /runs/:publicId/events resumable SSE, POST /runs/:publicId/cancel) " +
      "under apps/api's /v1/:org_slug/:workspace_slug scope (agent-engine v2 Phase 2 integration, " +
      "docs/specs/agent-engine-v2/plan.md). OFF by default: every route under /runs 404s until this " +
      "is set. Enqueues via @oxagen/agent-runner's RunStore (agent.agent_runs / agent.agent_run_events) " +
      "— the durable worker that actually executes a claimed run is separate, dispatch-only wiring.",
    secret: false,
    clientExposed: false,
    services: ["api"],
    requiredIn: [],
    valueOrigin: "static",
    staticValue: { "*": "false" },
  },
  OXAGEN_V1_RUN_ADMISSION_ENABLED: {
    group: "Observability",
    description:
      "Feature flag — METHOD-LEVEL gate on legacy RunSpec v1 admission (POST /runs only). " +
      'Set "0"/"false" to stop admitting NEW v1 runs. ON by default: PR 1A ships the dual ' +
      "v1/v2 reader while already-enqueued v1 work is still draining, and turning admission " +
      "off before the drain would be a change of behavior PR 1B owns (docs/specs/" +
      "run-evidence-ingress/02-run-attempt-foundation-plan.md Task 6). This gate is " +
      "DELIBERATELY separate from OXAGEN_DURABLE_RUNS, which mounts the whole /runs router: " +
      "disabling new v1 writes must never remove historical reads (GET status, resumable SSE) " +
      "or make already-queued rows unclaimable.",
    secret: false,
    clientExposed: false,
    services: ["api"],
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

  // ── Web Intelligence ────────────────────────────────────────────────────────
  TAVILY_API_KEY: {
    group: "Web Intelligence",
    description: "Tavily API key for web.search capability.",
    secret: true,
    clientExposed: false,
    services: ["api", "mcp"],
    requiredIn: [],
    valueOrigin: "manual",
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
  OXAGEN_MODEL: {
    group: "CLI",
    description:
      "Vercel AI Gateway model slug used by the CLI's local agent loop (e.g. " +
      "anthropic/claude-sonnet-5). Falls back to the value in ~/.config/oxagen/config.json, then a default.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
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
  OXAGEN_EFFORT: {
    group: "CLI",
    description:
      "Default reasoning effort for models that support a thinking mode: low | medium | high | xhigh | max " +
      "(xhigh/max are Anthropic-only depth tiers; other vendors clamp to high). Forwarded as reasoning " +
      "config per vendor; models without a reasoning mode ignore it. Unset = model default (Anthropic " +
      "adaptive thinking decides depth itself). Falls back to `effort` in ~/.config/oxagen/config.json / " +
      ".oxagen/settings.json, then the model default.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
  },
  OXAGEN_CLI_MOTION: {
    group: "CLI",
    description:
      "Motion mode for the CLI TUI animations: full | reduced | off. Overrides the persisted " +
      "`motion` config; unset falls back to config, then 'full'. (OXAGEN_CLI_FUN=0 is a legacy " +
      "alias that maps to 'reduced'.)",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "full",
  },
  OXAGEN_PLAN_TIMEOUT_MS: {
    group: "CLI",
    description:
      "Wall-clock bound in ms on the REPL's per-turn planner call (default 60000). Past the " +
      "bound the turn degrades to a router-derived single-task plan instead of hanging. " +
      "Set to '0' to disable the bound; a non-finite value is ignored.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "60000",
  },
  OXAGEN_CLI_FUN: {
    group: "CLI",
    description:
      "When '0', disables whimsical CLI animations: the REPL status rail's cat-and-mouse " +
      "chase, and `oxagen init`'s space-invaders/OXAGEN-reveal loading animation (which " +
      "falls back to plain progress lines instead). Any other value (or unset) keeps them on.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
  },
  OXAGEN_CLI_MOUSE: {
    group: "CLI",
    description:
      "When '0', the full-screen REPL starts with mouse-wheel transcript scrolling disabled " +
      "(terminal-native text selection stays available). Any other value (or unset) enables " +
      "mouse capture on launch; the /mouse command toggles it at runtime either way.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
  },
  OXAGEN_DISABLE_MEMORY: {
    group: "CLI",
    description:
      "When '1', the CLI one-shot runner skips session/fleet memory recall and remember entirely. " +
      "Benchmark harnesses (SWE-bench) set it so recalled context from one instance can never leak " +
      "into another when the same repo is reused across instances.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
  },
  OXAGEN_GRAPH_DISABLED: {
    group: "CLI",
    description:
      "When '1' or 'true', disables the CLI's code-graph context layer for the whole shell, so " +
      "the context resolver goes straight to the grep fallback (logged). Unset/other values keep " +
      "the graph-before-grep default on.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
  },
  OXAGEN_ROUTING_TRIVIAL_MAX: {
    group: "CLI",
    description:
      "Highest task complexity the CLI orchestrator handles on the coordinator model before " +
      "dispatching to a worker. One of the complexity-scale labels; invalid values fall back to " +
      "the built-in routing policy.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
  },
  OXAGEN_ROUTING_SWITCH_BUDGET: {
    group: "CLI",
    description:
      "Token budget guarding against low-value mid-turn model switches in the CLI orchestrator. " +
      "Non-negative number; invalid values fall back to the built-in routing policy.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
  },
  OXAGEN_ROUTING_CODE_WORKER: {
    group: "CLI",
    description:
      "Overrides the default code-worker model id the CLI orchestrator dispatches coding work to. " +
      "Falls back to the registry's `workerModels.defaultCode`.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
  },
  OXAGEN_ROUTING_BASIC_WORKER: {
    group: "CLI",
    description:
      "Overrides the cheap basic-work worker model id the CLI orchestrator dispatches lightweight " +
      "work to. Falls back to the registry's `workerModels.cheapBasic`.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
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
  OXAGEN_COORDINATOR: {
    group: "CLI",
    description:
      'Coordinator model for the CLI agent: "on-device" (default) or a cloud registry id ' +
      'like "haiku". Overrides `runtime.coordinator` in ~/.config/oxagen/config.json.',
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
  },
  OXAGEN_ONDEVICE_MODEL: {
    group: "CLI",
    description:
      'On-device model id: "auto" (resolve the best code model for this device) or a pinned ' +
      "capability-table modelId. Overrides `runtime.onDevice.modelId` in the CLI config.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
  },
  OXAGEN_MODELS_CACHE_DIR: {
    group: "CLI",
    description:
      "Override the on-device model weights cache directory (defaults to ~/.oxagen/models). " +
      "Overrides `runtime.onDevice.cacheDir` in the CLI config.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
  },
  OXAGEN_LLM_EVALUATOR: {
    group: "CLI",
    description:
      "Gateway model slug the CLI turn pipeline uses to evaluate each prompt (completeness " +
      '+ complexity scoring, context hints, refined rewrite). Defaults to "local" — the ' +
      "deterministic cost-router heuristic, no model call.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
  },
  OXAGEN_LLM_ADVISOR: {
    group: "CLI",
    description:
      "Gateway model slug the CLI uses as the completeness-judge advisor — always distinct from " +
      "the executor so work is never graded by the model that produced it. Defaults to the " +
      "flagship Anthropic model (Fable 5); set a cross-vendor slug (e.g. an OpenAI model) for " +
      "vendor-independent judging when a gateway key is available.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
  },
  OXAGEN_LLM_SELECTOR: {
    group: "CLI",
    description:
      "Gateway model slug `oxagen solve` (best-of-N) uses as the comparative selector that " +
      "picks the winning candidate. Defaults to the flagship Anthropic model (Fable 5); set a " +
      "cross-vendor slug for vendor-independent selection when a gateway key is available.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
  },
  OXAGEN_NO_TUI: {
    group: "CLI",
    description:
      "Set to any value to disable the interactive TUI in `oxagen` and always print classic help. " +
      "Unset or empty = TUI enabled (when running interactively in a terminal).",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
  },
  OXAGEN_CODE_GRAPH_DEBUG: {
    group: "CLI",
    description:
      "Set to '1' to emit verbose per-call / per-import diagnostics during code graph analysis. " +
      "Off by default as most misses are expected outcomes. Diagnostic output goes to stderr.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
  },
  OXAGEN_EMBED_PROVIDER: {
    group: "CLI",
    description:
      "Selects the code-graph embedding backend for `semantic_search`: 'auto' (default — a " +
      "local Ollama server if reachable, else an in-process ONNX model if installed, else the " +
      "platform gateway if a key is configured, else no vector ranking), 'ollama', 'onnx' " +
      "('local' also accepted), 'gateway', or 'off'. Local providers are free, offline, and use " +
      "no AI SDK, and their vectors stay local to the checkout. Overrides the " +
      "`graph.embedProvider` value in ~/.config/oxagen/config.json; " +
      "invalid values fall back to 'auto'.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "auto",
  },
  OLLAMA_HOST: {
    group: "CLI",
    description:
      "Base URL of the local Ollama server the CLI's 'ollama'/'auto' embedding provider talks " +
      "to. Same variable name Ollama itself uses, so an existing Ollama setup needs no new " +
      "config. Defaults to http://localhost:11434 when unset.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "http://localhost:11434",
  },
  OXAGEN_EMBED_MODEL: {
    group: "CLI",
    description:
      "Ollama embedding model the 'ollama'/'auto' embedding provider requests (must already be " +
      "pulled — `ollama pull <model>`). Defaults to 'nomic-embed-text'. Does not affect the ONNX " +
      "provider, which pins its own bundled model.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "nomic-embed-text",
  },
  OXAGEN_ALLOW_NO_SESSION: {
    group: "CLI",
    description:
      "Set to '1' to bypass the account-required gate (requireSession()) and return a " +
      "synthetic benchmark session instead of exiting. Only for headless benchmark " +
      "containers (bench/terminal-bench, bench/swe-bench) that run the agent path with " +
      "no logged-in account — never set this outside a benchmark/CI sandbox.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
  },
  OXAGEN_FORBID_TEST_EDITS: {
    group: "CLI",
    description:
      "Set to '1' to make buildWorkspaceTools structurally deny edit_file/write_file on " +
      "test-shaped paths (tests/, __tests__/, *.test.*, *_spec.rb, *Test.java, …), " +
      "returning a denial the model sees instead of a silent no-op. For benchmark " +
      "harnesses (SWE-bench) graded against hidden, fixed tests: an agent that edits the " +
      "tests it will be scored against 'passes' locally but scores 0, since the edit is " +
      "discarded before grading — never set this outside a benchmark/CI sandbox.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
  },
  OXAGEN_SPECULATIVE_TOOLS: {
    group: "CLI",
    description:
      "Speculative tool execution kill switch (docs/adr/ADR-030-speculative-tool-execution.md — ON by default). After every " +
      "read-tool result the engine predicts the model's likely next reads (truncation-marker " +
      "follow-ups, top grep hit files, first glob entries) and executes them early into a " +
      "per-turn promise cache; a matching real call awaits the same promise instead of " +
      "re-doing the I/O. Read-only allowlist (read_file/grep/glob/list_dir); ANY other tool " +
      "call invalidates the whole cache. Set to '0'/'false' to disable. The " +
      "RunCodingAgentOptions.speculativeTools option wins over this var.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "1",
  },
  OXAGEN_DISPATCH_GUARD: {
    group: "CLI",
    description:
      "Partitioned tool dispatch kill switch (agent-engine v2 Phase 0 — ON by default). " +
      "The engine gates a step's tool executions through a fair FIFO shared/exclusive gate: " +
      "non-mutating tools run concurrently capped at 8, mutating tools " +
      "(bash/write_file/edit_file plus MaterializedTools.mutatingToolNames) run as exclusive " +
      "barriers in call order — instead of the AI SDK's unawaited, uncapped execution of every " +
      "call. Set to '0'/'false' to disable. The RunCodingAgentOptions.dispatchGuard option " +
      "wins over this var.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "1",
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
  OXAGEN_BEST_OF_N_PIPELINE: {
    group: "CLI",
    description:
      "Set to '1' to default `oxagen solve` (best-of-N) candidates to the full " +
      "evaluate→enhance→route→execute→judge→revise pipeline instead of the bare engine " +
      "loop, when the `--pipeline` flag isn't passed explicitly. Lets a caller (e.g. the " +
      "bench adapter's differentiated config) opt every `solve` invocation into the " +
      "pricier, more thorough pipeline mode without passing the flag on every call. " +
      "Neither the flag nor this var set ⇒ bare mode, the cheaper default.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
  },
  OXAGEN_BEST_OF_N_VERIFY: {
    group: "CLI",
    description:
      "Set to '1' to default `oxagen solve` (best-of-N) candidates to auto-verify: union " +
      "and re-run the test/lint/build commands any candidate ran, across every surviving " +
      "candidate's worktree, before selection — when the `--verify-auto` flag isn't passed " +
      "explicitly. Mirrors OXAGEN_BEST_OF_N_PIPELINE's precedence (flag wins, then env, " +
      "neither ⇒ off) so the bench adapter's differentiated config can turn it on without " +
      "passing the flag on every call.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
  },
  OXAGEN_BEST_OF_N_MODE: {
    group: "CLI",
    description:
      "Set to 'fork' or 'independent' to select best-of-N mode. Fork mode snapshots the " +
      "trunk conversation at the diagnosis point and runs cache-forked tails per hypothesis, " +
      "reusing the trunk's investigation at ~10× input discount via prompt caching. " +
      "Independent mode runs N complete independent pipelines. Default is 'independent'.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "independent",
  },
  OXAGEN_LOCAL: {
    group: "CLI",
    description:
      "Set to '1' (or pass `--local`) to force local BYOK mode even when logged in: " +
      "the CLI runs the coordinator + workers with your own key — AI_GATEWAY_API_KEY " +
      "(gateway-direct, any vendor; preferred) or ANTHROPIC_API_KEY (Anthropic API " +
      "direct, Anthropic models only) — instead of routing through your Oxagen " +
      "account. When not logged in, BYOK is used automatically if either key is " +
      "present, so this flag is only needed to override an existing login.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
  },
  OXAGEN_COMMIT_LEDGER: {
    group: "CLI",
    description:
      "Path to the append-only JSON-lines commit ledger that records every agent commit " +
      "so work is never lost even if a branch is force-moved or a worktree removed. " +
      "Defaults to ~/.oxagen/commit-ledger.jsonl.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "~/.oxagen/commit-ledger.jsonl",
  },
  OXAGEN_PROMPT_PROFILE: {
    group: "CLI",
    description:
      "Force the agent system-prompt profile: 'interactive' (narrates for a live " +
      "watcher) or 'headless' (strips narration, adds a verification protocol for " +
      "autonomous/one-shot/SWE-bench runs). Unset ⇒ auto (headless when stdout is " +
      "not a TTY, interactive otherwise).",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "headless",
  },
  OXAGEN_ENHANCE_TIMEOUT_MS: {
    group: "CLI",
    description:
      "Wall-clock budget (ms) for the ENHANCE stage's code-graph pass. On a cold " +
      "store the first graph query triggers a full tree-sitter build (minutes on a " +
      "large repo), so headless one-shot bounds it to 15s by default; whatever " +
      "resolved in budget is injected and the build keeps warming in the background. " +
      "Set explicitly to override; 0 disables the bound. Unset ⇒ 15000 headless, " +
      "unbounded interactive.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "15000",
  },
  OXAGEN_TURN_INACTIVITY_MS: {
    group: "CLI",
    description:
      "Turn inactivity guard window (ms, default 300000). NOT a turn time cap: aborts a turn " +
      "only when no model/tool progress lands within the window; any completed call, stream " +
      "delta, or executing tool resets/defers it. For long CI waits prefer the built-in " +
      "pre-abort CI probe (OXAGEN_CI_WAIT_CAP_MS) over raising this — a large window blinds " +
      "the hang backstop. Non-finite or <=0 values are ignored.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "300000",
  },
  OXAGEN_CI_WAIT_CAP_MS: {
    group: "CLI",
    description:
      "Cap (ms, default 7200000 = 2h) on how long the turn inactivity guard may keep extending " +
      "for a confirmed CI wait: before aborting, a turn that ran a CI-watch tool (gh run watch / " +
      "gh pr checks…) makes one call-out, and still-pending checks extend the window until this " +
      "cumulative cap. Green/failed/no-PR/probe-error never extends.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "7200000",
  },
  OXAGEN_JUDGE_PANEL: {
    group: "CLI",
    description:
      "Comma-separated gateway model slugs to use as a CROSS-VENDOR completeness " +
      "judge panel instead of a single judge (majority rules, findings unioned). " +
      "Higher cost, higher recall on incomplete work. Unset ⇒ single judge.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "openai/gpt-5,google/gemini-2.5-pro",
  },
  OXAGEN_MID_JUDGE_STEPS: {
    group: "CLI",
    description:
      "Step count at which the mid-session completeness judge fires during a headless " +
      "one-shot run. After this many tool-call steps in round 0, the pipeline pauses, " +
      "runs judgeCompleteness, and injects any findings as a phase-B instruction before " +
      "continuing — catching incomplete acceptance criteria (e.g. missing test cases) " +
      "early rather than only at the end. 0 or unset disables the mid-session check. " +
      "Default in headless mode: 20. Only for headless/benchmark runs.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "20",
  },
  OXAGEN_MAX_REVISE_ROUNDS: {
    group: "CLI",
    description:
      "Max judge→revise rounds the turn pipeline runs before giving up on an incomplete " +
      "verdict. 0 disables auto-revision entirely. Unset ⇒ 1. Only affects the full " +
      "(non-bare) pipeline — bare execution (best-of-N's default) has no judge/revise loop.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "2",
  },
  OXAGEN_MUTATION_VERIFY: {
    group: "CLI",
    description:
      "Mutation gate (layer 1) kill switch. ON by default: after a judged-complete round, " +
      "the pipeline reverts the fix in a shadow (test files stay put), re-runs the agent's " +
      "own passing test command, and demands a failure — a test that still passes without " +
      "the fix witnesses nothing, and the verdict is overridden into a revise round. " +
      "Set 0/false to disable. The RunTurnOptions.mutationVerify option wins over this var.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "1",
  },
  OXAGEN_MUTATION_SCORE: {
    group: "CLI",
    description:
      "Mutation gate layer 2 (opt-in): when the witness check passes, apply deterministic " +
      "one-line mutants to the fix's added lines and measure the kill rate (each mutant " +
      "costs one witness-command run). Reported on the trace as mutationGates[].score.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "1",
  },
  OXAGEN_MUTATION_TIMEOUT_MS: {
    group: "CLI",
    description:
      "Per-command timeout (ms) for the mutation gate's witness re-runs in the fix-reverted " +
      "shadow. Unset ⇒ 180000. A timed-out witness run counts as a failure (the shadow " +
      "behaves differently without the fix), which still proves the tests witness the fix.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "180000",
  },
  OXAGEN_REVISE_MIN_CONFIDENCE: {
    group: "CLI",
    description:
      "Perf #10: minimum judge confidence (0-100) an 'incomplete' verdict must carry before " +
      "the pipeline spends a full execute+judge round revising it. A low-confidence incomplete " +
      "call is a coin-flip that leans complete, so revising it doubles turn cost for marginal " +
      "expected gain — confident-incomplete verdicts still revise. Default 40; 0 restores " +
      "always-revise.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "40",
  },
  OXAGEN_JUDGE_FAST_COMPLEXITY_MAX: {
    group: "CLI",
    description:
      "Complexity ceiling (0-100) under which pickTieredAdvisor substitutes a cheap 'fast' " +
      "tier model as the completeness judge instead of the executor's own model, provided the " +
      "diff also stays under OXAGEN_DIFF_BUDGET. An explicit OXAGEN_LLM_ADVISOR always wins. A " +
      "non-positive value opts out entirely. Default 35.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "35",
  },
  OXAGEN_SPEC_GATE: {
    group: "CLI",
    description:
      "Enable the spec-first oracle gate (F2): at mid-session judge point, if no failing " +
      "test repro has been executed, inject a corrective instruction instead of generic " +
      "completeness judgment. Enforces test-before-patch discipline. 0 or unset disables. " +
      "Only for headless/benchmark runs.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "1",
  },
  OXAGEN_LADDER: {
    group: "CLI",
    description:
      "Deterministic judge-skip / adaptive compute ladder (docs/adr/ADR-021-inference-doctrine.md §1). ON BY DEFAULT: " +
      "the frontier completeness judge is skipped when executed evidence already settles " +
      "the outcome (oracle flipped + touched tests green + diff within budget, or a " +
      "read-only turn with no diff). Set to 0/false to OPT OUT and force the judge to run " +
      "every round.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "0",
  },
  OXAGEN_DIFF_BUDGET: {
    group: "CLI",
    description:
      "Line-count threshold (default 120) for the fast-path terminal condition in the " +
      "adaptive ladder (F3). When oracle is 'flipped' and touched-file tests pass, " +
      "if diff lines ≤ budget, skip judge and submit. Only applies while judge-skip is enabled (the default; opt out via OXAGEN_LADDER=0).",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "120",
  },
  OXAGEN_LADDER_MAX_RUNG: {
    group: "CLI",
    description:
      "Hard cap on ladder rung (0–3) in the adaptive compute controller (F3). " +
      "Prevents escalation beyond the specified rung even when signals suggest higher. " +
      "Default 3 (no cap). 0–3 only; invalid values silently use default. " +
      "Only applies while judge-skip is enabled (the default; opt out via OXAGEN_LADDER=0).",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "3",
  },
  OXAGEN_LOCALIZE: {
    group: "CLI",
    description:
      "Enable F1 deterministic zero-token localization: parse tracebacks and " +
      "extract symbols from the issue to rank candidate files before the first LLM call. " +
      "Default on (runs unless explicitly set to '0'). Unset or '1' enables, '0' disables.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
  },
  OXAGEN_REPO_PRIORS: {
    group: "CLI",
    description:
      "Enable F8 per-repo procedural priors: inject cached layout, conventions, and accrued pitfalls " +
      "learned from prior instances. Requires both repo and priorsDir options to be set in the caller. " +
      "Default off. Unset or '0' disables, '1' enables.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "1",
  },
  OXAGEN_RECALL_FILTER: {
    group: "CLI",
    description:
      "Enable F9 memory-recall applicability filter: drop recalled items with zero lexical overlap " +
      "with the issue and candidate files, then optionally score survivors for semantic relevance. " +
      "Reduces noise in injected memory. Default off. Unset or '0' disables, '1' enables.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "1",
  },
  OXAGEN_FLEET_DIR: {
    group: "CLI",
    description:
      "Overrides the fleet store root (default `~/.oxagen/fleet`) that backs `oxagen fleet` " +
      "session tracking (docs/adr/ADR-023-cli-fleet-session-event-log.md). Used by tests and sandboxes to isolate the fleet store from " +
      "a developer's real `~/.oxagen` directory; never set in deployed environments.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
  },
  OXAGEN_FLEET_RECORD: {
    group: "CLI",
    description:
      "Toggles the docs/adr/ADR-028-time-travel-replay.md sidecar record (`record/record.ndjson` + blob store) " +
      "written by every `oxagen fleet` session. Recording is default-ON; set to `0` or `off` " +
      "to disable. CLI-local only; never set in deployed environments.",
    secret: false,
    clientExposed: false,
    services: [],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "off",
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
  BILLING_ENCRYPTION_KEY: {
    group: "Billing",
    description:
      "Base64-encoded 32-byte master key for AES-256-GCM encryption of per-org reseller Stripe keys (reseller revenue). Optional: falls back to INGESTION_ENCRYPTION_KEY when unset.",
    secret: true,
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

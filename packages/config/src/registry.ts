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
export const ENV_NAMES: readonly EnvName[] = ["development", "preview", "production"];

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

const APP_PROD_URL = "https://oxagen-v2-app.vercel.app";
const API_PROD_URL = "https://oxagen-v2-api.vercel.app";

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
    staticValue: { development: "development", preview: "production", production: "production" },
  },

  // ── Postgres (Neon in prod, Docker locally) ─────────────────────────────────
  DATABASE_URL: {
    group: "Postgres",
    description: "Neon Postgres connection string. Prod = live branch; preview/dev = dev branch.",
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
    staticValue: { development: "http://localhost:3000", production: APP_PROD_URL },
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
    staticValue: { development: "http://localhost:3000", production: APP_PROD_URL },
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

  // ── OAuth providers ─────────────────────────────────────────────────────────
  // Google OAuth is split into a LOGIN client (minimal openid/profile/email,
  // in use for social sign-in) and a DATA client (Workspace data scopes,
  // reserved for the future google-workspace connection).
  GOOGLE_LOGIN_CLIENT_ID: {
    group: "OAuth providers",
    description: "Google LOGIN OAuth client id (social sign-in; minimal scopes).",
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
    description: "Google DATA OAuth client id (Workspace data scopes; future connection).",
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
    description: "GitHub LOGIN OAuth client id (social sign-in; minimal scopes).",
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
    description: "GitHub DATA OAuth client id (repo-ingestion scopes; future connection).",
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
    description: "Stripe publishable key (pk_live in prod, pk_test in preview/dev).",
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
  // restrictions in the Google Cloud console). The SECRET var is unused by our
  // code; note that its NEXT_PUBLIC_ prefix means Next.js would still inline it
  // into the client bundle — a real signing secret belongs in a server-only var.
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
  AI_GATEWAY_API_KEY: {
    group: "AI providers",
    description:
      "Vercel AI Gateway token — the platform's single AI auth. @oxagen/ai routes " +
      "every model call (text, image, embeddings, video) through the gateway; there " +
      "is no direct-provider fallback, so this is required wherever AI runs.",
    secret: true,
    clientExposed: false,
    services: ["api", "app", "mcp"],
    requiredIn: DEPLOYED,
    valueOrigin: "manual",
  },
  OXAGEN_LLM_FAST: {
    group: "AI providers",
    description:
      "Fast text tier (\"Oxagen Fast\") — the gateway model id @oxagen/ai resolves for " +
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
    description: "Balanced text tier (\"Oxagen Balanced\") — gateway model id for the balanced tier.",
    secret: false,
    clientExposed: false,
    services: ["api", "app", "mcp"],
    requiredIn: [],
    valueOrigin: "static",
    staticValue: { "*": "anthropic/claude-sonnet-4.6" },
  },
  OXAGEN_LLM_PRECISE: {
    group: "AI providers",
    description: "Precise text tier (\"Oxagen Precise\") — gateway model id for the precise tier.",
    secret: false,
    clientExposed: false,
    services: ["api", "app", "mcp"],
    requiredIn: [],
    valueOrigin: "static",
    staticValue: { "*": "anthropic/claude-opus-4.8" },
  },
  OXAGEN_LLM_IMAGE_BASIC: {
    group: "AI providers",
    description:
      "Basic image tier (\"Oxagen Basic\") — default gateway image model for composer " +
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
    description: "Advanced image tier (\"Oxagen Advanced\") — high-fidelity gateway image model.",
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
      "Basic video tier (\"Oxagen Basic\") — default gateway video model for composer " +
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
    description: "Advanced video tier (\"Oxagen Advanced\") — high-fidelity gateway video model.",
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
    description: "SMTP port. 465 = implicit TLS; 587 = STARTTLS (TLS enforced).",
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
    description: "Default sender address. Its domain must be verified at the provider.",
    secret: false,
    clientExposed: false,
    services: ["api", "app", "mcp", "website", "admin"],
    requiredIn: [],
    valueOrigin: "static",
    staticValue: { "*": "noreply@notifications.oxagen.ai" },
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
    description: "Linear API key (tooling/provenance; not read by deployed apps).",
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
    staticValue: { development: "http://localhost:3000", production: APP_PROD_URL },
  },
  NEXT_PUBLIC_API_URL: {
    group: "Public URLs",
    description: "Public api origin (browser-exposed).",
    secret: false,
    clientExposed: true,
    services: ["app", "website"],
    requiredIn: ALL,
    valueOrigin: "static",
    staticValue: { development: "http://localhost:4000", production: API_PROD_URL },
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
    staticValue: { development: "http://localhost:3000", production: APP_PROD_URL },
  },

  // ── IAM enforcement ─────────────────────────────────────────────────────────
  IAM_ENFORCEMENT_ENABLED: {
    group: "IAM",
    description:
      "Master switch for capability-level IAM checks. Default true (secure). " +
      "Set false only for break-glass; revert before the end of the incident.",
    secret: false,
    clientExposed: false,
    services: ["api", "app", "mcp"],
    requiredIn: [],
    valueOrigin: "static",
    staticValue: { "*": "true" },
  },

  // ── Security / RLS enforcement ───────────────────────────────────────────────
  TENANT_RLS_ENFORCEMENT_ENABLED: {
    group: "Security",
    description:
      "When true, Postgres RLS policies filter by org/workspace. Production-safe " +
      "default — leave true for all deployed environments. Local dev override: set " +
      "false in .env.local only if seeding/migration scripts need to bypass RLS; " +
      "revert to true before running app code against the DB.",
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
    staticValue: { development: "docker", preview: "vercel", production: "vercel" },
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
    description: "Vercel Sandbox token (SANDBOX_DRIVER=vercel; OIDC auto-resolves on Vercel).",
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

  // ── env-manager tooling (operator/local-only; never pushed to app projects) ──
  VERCEL_TOKEN: {
    group: "env-manager tooling",
    description: "Vercel API token (admin) the env-manager uses to read/write project env vars.",
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
      "Vercel team slug for `pnpm env:pull` --scope (e.g. \"oxagen\"). Optional — when unset, " +
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
      "HMAC-SHA256 secret for signing audit-log export tokens. Required by the audit " +
      "export route (apps/app) so exported files can be verified as untampered. " +
      "Generate with `openssl rand -base64 32`.",
    secret: true,
    clientExposed: false,
    services: ["app"],
    requiredIn: ["production"],
    valueOrigin: "generate",
    placeholder: "",
  },

  // ── CLI / tooling ────────────────────────────────────────────────────────────
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
    staticValue: { development: "http://localhost:4000", production: "https://oxagen-v2-api.vercel.app" },
  },
};

// ─── Derivations (the single place every surface reads from) ─────────────────

const SCHEMA_KEYS: ReadonlySet<string> = new Set(Object.keys(baseEnvSchema.shape));

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
    .filter(([, m]) => m.services.includes(service) && m.requiredIn.includes(env))
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
    if (meta.requiredIn.length > 0) flags.push(`required:${meta.requiredIn.join("/")}`);
    else flags.push("optional");
    lines.push(`# ${meta.description}${flags.length ? `  [${flags.join(", ")}]` : ""}`);
    const value = staticValueFor(key, "development") ?? meta.placeholder ?? "";
    lines.push(`${key}=${value}`);
    lines.push("");
  }
  return lines.join("\n").replace(/\n+$/, "\n");
}

import type { CatalogEntry } from "./types.js";

// Production URLs (interim Vercel-managed domains; see CLAUDE.md).
const APP_PROD_URL = "https://oxagen-v2-app.vercel.app";
const API_PROD_URL = "https://oxagen-v2-api.vercel.app";

// gsm() for the three-env case where the same secret is used everywhere.
const gsmAll = (secret: string): CatalogEntry["sources"] => ({
  production: { type: "gsm", secret },
  preview: { type: "gsm", secret },
  development: { type: "gsm", secret },
});

// The single source of truth for "what env var goes where".
//
// `services` = which Vercel projects need the var. `sources` = where each
// environment's value comes from. Production pulls live/prod credentials;
// preview + development pull the dev/test instances (Neon dev branch, Stripe
// test keys, etc.) — matching the intent that preview branches behave like
// local dev, not production.
export const CATALOG: CatalogEntry[] = [
  // ---- Postgres (Neon) ----
  {
    key: "DATABASE_URL",
    group: "Postgres (Neon)",
    description: "Neon Postgres connection string. Prod = oxagen-pg-production; preview/dev = oxagen-pg-dev.",
    secret: true,
    services: ["api", "app", "mcp", "admin"],
    sources: {
      production: { type: "gsm", secret: "oxagen-database-url-production" },
      preview: { type: "gsm", secret: "oxagen-database-url-development" },
      development: { type: "gsm", secret: "oxagen-database-url-development" },
    },
  },

  // ---- ClickHouse ----
  { key: "CLICKHOUSE_URL", group: "ClickHouse", description: "ClickHouse HTTPS endpoint.", secret: false, services: ["api", "mcp"], sources: gsmAll("oxagen-clickhouse-url") },
  { key: "CLICKHOUSE_USERNAME", group: "ClickHouse", description: "ClickHouse user.", secret: false, services: ["api", "mcp"], sources: gsmAll("oxagen-clickhouse-user") },
  { key: "CLICKHOUSE_PASSWORD", group: "ClickHouse", description: "ClickHouse password.", secret: true, services: ["api", "mcp"], sources: gsmAll("oxagen-clickhouse-password") },
  { key: "CLICKHOUSE_DATABASE", group: "ClickHouse", description: "ClickHouse database name.", secret: false, services: ["api", "mcp"], sources: { production: { type: "static", value: "oxagen" }, preview: { type: "static", value: "oxagen" }, development: { type: "static", value: "oxagen" } } },

  // ---- Neo4j (Aura, us-west) ----
  { key: "NEO4J_URI", group: "Neo4j (Aura)", description: "Neo4j bolt+s URI.", secret: false, services: ["api", "mcp"], sources: gsmAll("oxagen-neo4j-shared-uswest1-uri") },
  { key: "NEO4J_USERNAME", group: "Neo4j (Aura)", description: "Neo4j user.", secret: false, services: ["api", "mcp"], sources: gsmAll("oxagen-neo4j-shared-uswest1-username") },
  { key: "NEO4J_PASSWORD", group: "Neo4j (Aura)", description: "Neo4j password.", secret: true, services: ["api", "mcp"], sources: gsmAll("oxagen-neo4j-shared-uswest1-password") },
  { key: "NEO4J_DATABASE", group: "Neo4j (Aura)", description: "Neo4j database.", secret: false, services: ["api", "mcp"], sources: { production: { type: "static", value: "neo4j" }, preview: { type: "static", value: "neo4j" }, development: { type: "static", value: "neo4j" } } },

  // ---- Better Auth ----
  {
    key: "BETTER_AUTH_SECRET",
    group: "Better Auth",
    description: "Session/cookie signing secret (≥32 chars). Generated once per environment and applied identically to api + app so sessions validate across both.",
    secret: true,
    services: ["api", "app"],
    sources: { production: { type: "generate", bytes: 32 }, preview: { type: "generate", bytes: 32 }, development: { type: "generate", bytes: 32 } },
  },
  {
    key: "BETTER_AUTH_URL",
    group: "Better Auth",
    description: "Auth base URL (the app origin). Preview is per-deploy — leave it managed at runtime (omitted here).",
    secret: false,
    services: ["api", "app"],
    sources: { production: { type: "static", value: APP_PROD_URL }, development: { type: "static", value: "http://localhost:3000" } },
  },

  // ---- Stripe (live in prod, test in preview/dev) ----
  { key: "STRIPE_SECRET_KEY", group: "Stripe", description: "Stripe secret key (sk_live in prod, sk_test in preview/dev).", secret: true, services: ["api", "app"], sources: { production: { type: "gsm", secret: "oxagen-stripe-secret" }, preview: { type: "gsm", secret: "oxagen-stripe-secret-development" }, development: { type: "gsm", secret: "oxagen-stripe-secret-development" } } },
  { key: "STRIPE_PUBLISHABLE_KEY", group: "Stripe", description: "Stripe publishable key (pk_live in prod, pk_test in preview/dev).", secret: false, services: ["api", "app"], sources: { production: { type: "gsm", secret: "oxagen-stripe-publishable-key" }, preview: { type: "gsm", secret: "oxagen-stripe-secret-staging" }, development: { type: "gsm", secret: "oxagen-stripe-secret-staging" } } },
  { key: "STRIPE_WEBHOOK_SECRET", group: "Stripe", description: "Stripe webhook signing secret (whsec_).", secret: true, services: ["api", "app"], sources: gsmAll("oxagen-stripe-webhook-secret") },

  // ---- Inngest (manual: app.inngest.com -> your app -> Keys) ----
  { key: "INNGEST_EVENT_KEY", group: "Inngest (manual)", description: "From app.inngest.com -> app -> Keys. Required in prod + preview.", secret: true, services: ["api", "app"], sources: { production: { type: "manual" }, preview: { type: "manual" } } },
  { key: "INNGEST_SIGNING_KEY", group: "Inngest (manual)", description: "From app.inngest.com -> app -> Keys. Required in prod + preview.", secret: true, services: ["api", "app"], sources: { production: { type: "manual" }, preview: { type: "manual" } } },

  // ---- LLM providers (manual) ----
  { key: "ANTHROPIC_API_KEY", group: "LLM (manual)", description: "Anthropic API key.", secret: true, services: ["api", "app", "mcp"], sources: { production: { type: "manual" }, preview: { type: "manual" }, development: { type: "manual" } } },
  { key: "OPENAI_API_KEY", group: "LLM (manual)", description: "OpenAI API key (embeddings).", secret: true, services: ["api", "app", "mcp"], sources: { production: { type: "manual" }, preview: { type: "manual" }, development: { type: "manual" } } },

  // ---- Public URLs (Next, browser-exposed) ----
  { key: "NEXT_PUBLIC_APP_URL", group: "Public URLs", description: "Public app origin.", secret: false, services: ["app", "website"], sources: { production: { type: "static", value: APP_PROD_URL }, development: { type: "static", value: "http://localhost:3000" } } },
  { key: "NEXT_PUBLIC_API_URL", group: "Public URLs", description: "Public api origin.", secret: false, services: ["app", "website"], sources: { production: { type: "static", value: API_PROD_URL }, development: { type: "static", value: "http://localhost:8787" } } },
  { key: "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", group: "Public URLs", description: "Browser-exposed Stripe publishable key (mirrors STRIPE_PUBLISHABLE_KEY).", secret: false, services: ["app"], sources: { production: { type: "gsm", secret: "oxagen-stripe-publishable-key" }, preview: { type: "gsm", secret: "oxagen-stripe-secret-staging" }, development: { type: "gsm", secret: "oxagen-stripe-secret-staging" } } },
];

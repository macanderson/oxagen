// Hand-authored knowledge about the GCP secrets: how each one reconciles to a
// repo env var, where to regenerate it, what it is, and (when it's a random
// value) the exact CLI command to mint a fresh one.
//
// Two responsibilities:
//   1. RECONCILIATION — map a GCP secret name (e.g. `oxagen-stripe-secret`) to a
//      repo env-var key (`STRIPE_SECRET_KEY`) so the puller can find the freshest
//      value in creds.txt / .env.local even when the names don't line up.
//   2. DOCUMENTATION — derive a vendor_url and a one/two-sentence description
//      (with a CLI mint command appended when the secret is just random bytes).
//
// Reconciliation is alias-first, then a normalized-name fallback. Documentation
// is registry-first (reuse the rich descriptions in @oxagen/config), then a
// provider table keyed off the secret name.
import { ENV_REGISTRY } from "@oxagen/config";

// ── 1. Reconciliation ────────────────────────────────────────────────────────

/** Env-name suffixes GCP appends to per-stage secrets; stripped before matching. */
const ENV_SUFFIXES = [
  "-production",
  "-development",
  "-staging",
  "-sandbox",
  "-public-development",
  "-public-staging",
  "-dev",
  "-prod",
];

/**
 * Explicit GCP-secret → repo-env-key aliases for the cases a normalized compare
 * can't get right (renamed providers, ambiguous splits, AI-gateway routing).
 * The value is the canonical repo env var the secret corresponds to.
 */
export const ALIAS: Record<string, string> = {
  // AI providers — repo routes everything through the AI Gateway, but each raw
  // provider key still exists in GCP. Point them at their nearest repo var.
  "anthropic-api-key": "AI_GATEWAY_API_KEY",
  "oxagen-anthropic-key": "AI_GATEWAY_API_KEY",
  "oxagen-openai-api-key": "AI_GATEWAY_API_KEY",
  "mistral-api-key": "AI_GATEWAY_API_KEY",
  "oxagen-embedding-api-key": "AI_GATEWAY_API_KEY",
  // Postgres
  "oxagen-database-url": "DATABASE_URL",
  DATABASE_URL: "DATABASE_URL",
  // ClickHouse (telemetry analytics store)
  "oxagen-clickhouse-url": "CLICKHOUSE_URL",
  "oxagen-clickhouse-user": "CLICKHOUSE_USERNAME",
  "oxagen-clickhouse-password": "CLICKHOUSE_PASSWORD",
  "clickpipes-password": "CLICKHOUSE_PASSWORD",
  // Neo4j (region-sharded in GCP; one logical repo var each)
  "oxagen-neo4j-shared-uswest1-uri": "NEO4J_URI",
  "oxagen-neo4j-shared-uswest1-username": "NEO4J_USERNAME",
  "oxagen-neo4j-shared-uswest1-password": "NEO4J_PASSWORD",
  // Better Auth + crypto
  "oxagen-admin-auth-secret": "BETTER_AUTH_SECRET",
  "oxagen-encryption-key": "INGESTION_ENCRYPTION_KEY",
  // OAuth — login clients
  "oxagen-google-client-id": "GOOGLE_LOGIN_CLIENT_ID",
  "oxagen-google-client-secret": "GOOGLE_LOGIN_CLIENT_SECRET",
  "oxagen-google-connections-client-id": "GOOGLE_DATA_CLIENT_ID",
  "oxagen-google-connections-client-secret": "GOOGLE_DATA_CLIENT_SECRET",
  // GitHub App connector
  "oxagen-github-app-client-id": "GITHUB_APP_CLIENT_ID",
  "oxagen-github-app-client-secret": "GITHUB_APP_CLIENT_SECRET",
  "oxagen-github-app-webhook-secret": "GITHUB_APP_WEBHOOK_SECRET",
  "oxagen-github-app-install-state-secret": "GITHUB_APP_INSTALL_STATE_SECRET",
  // Stripe
  "oxagen-stripe-secret": "STRIPE_SECRET_KEY",
  "oxagen-stripe-publishable-key": "STRIPE_PUBLISHABLE_KEY",
  "oxagen-stripe-webhook-secret": "STRIPE_WEBHOOK_SECRET",
  // Email / SMTP (Resend)
  "oxagen-resend-api-key": "SMTP_PASSWORD",
  "oxagen-smtp-password": "SMTP_PASSWORD",
  // Inngest / web intel / storage / sandbox
  "oxagen-tavily-api-key": "TAVILY_API_KEY",
  "oxagen-vercel-token": "VERCEL_TOKEN",
  // Linear
  "oxagen-linear-api-key": "LINEAR_API_KEY",
};

/**
 * Canonicalize a name for fuzzy matching: drop the `oxagen-` prefix and any
 * env suffix, upcase, and collapse separators to `_`. Used to align GCP names
 * with repo env keys when no explicit alias exists.
 */
export function canonicalize(name: string): string {
  let n = name.toLowerCase();
  if (n.startsWith("oxagen-")) n = n.slice("oxagen-".length);
  for (const suf of ENV_SUFFIXES) {
    if (n.endsWith(suf)) {
      n = n.slice(0, -suf.length);
      break;
    }
  }
  return n.replace(/[^a-z0-9]+/g, "_").toUpperCase();
}

const REGISTRY_KEYS = Object.keys(ENV_REGISTRY);
const REGISTRY_BY_CANON = new Map<string, string>(
  REGISTRY_KEYS.map((k) => [canonicalize(k), k]),
);

/**
 * Resolve the repo env var a GCP secret maps to, if any. Alias first, then exact
 * registry key, then canonical-name equality against the registry.
 */
export function resolveEnvKey(gcpName: string): string | null {
  const aliasByRaw = ALIAS[gcpName];
  if (aliasByRaw) return aliasByRaw;
  const canon = canonicalize(gcpName);
  const aliasByCanon = ALIAS[canon.toLowerCase()];
  if (aliasByCanon) return aliasByCanon;
  if (ENV_REGISTRY[gcpName]) return gcpName;
  return REGISTRY_BY_CANON.get(canon) ?? null;
}

// ── 2. Documentation: CLI mint commands ──────────────────────────────────────

/**
 * For secrets that are just random material, the exact command to mint a fresh
 * one. Returned as a short clause to append to the description. Order matters:
 * the most specific pattern wins.
 */
export function cliGenCommand(gcpName: string): string | null {
  const n = gcpName.toLowerCase();
  if (n.includes("jwt-private-key"))
    return "Generate: `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out jwt.pem`";
  if (n.includes("jwt-public-key"))
    return "Generate from the private key: `openssl pkey -in jwt.pem -pubout -out jwt.pub`";
  if (
    /encryption-key|auth-secret|jwt-secret|install-state-secret|internal-api-secret|admin-api-secret|plugin-api-secret|signing/.test(
      n,
    )
  )
    return "Generate: `openssl rand -base64 32`";
  if (/password|valkey-auth|-auth$|pgadmin/.test(n))
    return "Generate: `openssl rand -base64 24`";
  return null;
}

// ── 2. Documentation: provider table ─────────────────────────────────────────

interface Provider {
  id: string;
  /** Matches the GCP secret name (already lower-cased). */
  test: (n: string) => boolean;
  /** Dashboard page to generate/rotate the credential. */
  url: string;
  /** One-sentence description (CLI mint clause appended separately). */
  describe: (n: string) => string;
}

/** Title-case a stripped secret fragment for human descriptions. */
function humanize(gcpName: string): string {
  return canonicalize(gcpName).replace(/_/g, " ").toLowerCase();
}

const PROVIDERS: Provider[] = [
  {
    id: "anthropic",
    test: (n) => n.includes("anthropic"),
    url: "https://console.anthropic.com/settings/keys",
    describe: () =>
      "Anthropic API key. The platform routes Claude calls through the Vercel AI Gateway, so prefer AI_GATEWAY_API_KEY in deployed envs.",
  },
  {
    id: "openai",
    test: (n) => n.includes("openai"),
    url: "https://platform.openai.com/api-keys",
    describe: () =>
      "OpenAI API key (image/embeddings). Routed through the AI Gateway in deployed envs.",
  },
  {
    id: "mistral",
    test: (n) => n.includes("mistral"),
    url: "https://console.mistral.ai/api-keys",
    describe: () =>
      "Mistral API key. Routed through the AI Gateway in deployed envs.",
  },
  {
    id: "elevenlabs",
    test: (n) => n.includes("elevenlabs"),
    url: "https://elevenlabs.io/app/settings/api-keys",
    describe: () => "ElevenLabs API key for text-to-speech generation.",
  },
  {
    id: "ideogram",
    test: (n) => n.includes("ideogram"),
    url: "https://ideogram.ai/manage-api",
    describe: () => "Ideogram API key for image generation.",
  },
  {
    id: "runway",
    test: (n) => n.includes("runway"),
    url: "https://dev.runwayml.com/",
    describe: () => "Runway API secret for video generation.",
  },
  {
    id: "tavily",
    test: (n) => n.includes("tavily"),
    url: "https://app.tavily.com/home",
    describe: () => "Tavily API key powering the web.search capability.",
  },
  {
    id: "e2b",
    test: (n) => n.includes("e2b"),
    url: "https://e2b.dev/dashboard?tab=keys",
    describe: () => "E2B API key for sandboxed code execution.",
  },
  {
    id: "embedding",
    test: (n) => n.includes("embedding"),
    url: "https://platform.openai.com/api-keys",
    describe: () =>
      "Embedding-model API key. Routed through the AI Gateway in deployed envs.",
  },
  {
    id: "stripe-price",
    test: (n) => n.includes("stripe-price"),
    url: "https://dashboard.stripe.com/products",
    describe: (n) =>
      `Stripe price id for "${humanize(n).replace("stripe price ", "")}". Synced via \`pnpm billing:stripe-sync\`.`,
  },
  {
    id: "stripe-webhook",
    test: (n) => n.includes("stripe") && n.includes("webhook"),
    url: "https://dashboard.stripe.com/webhooks",
    describe: () =>
      "Stripe webhook signing secret (whsec_) validating inbound Stripe events.",
  },
  {
    id: "stripe",
    test: (n) => n.includes("stripe"),
    url: "https://dashboard.stripe.com/apikeys",
    describe: (n) =>
      n.includes("publishable")
        ? "Stripe publishable key (pk_)."
        : "Stripe secret key (sk_).",
  },
  {
    id: "linear",
    test: (n) => n.includes("linear"),
    url: "https://linear.app/settings/api",
    describe: (n) =>
      n.includes("webhook")
        ? "Linear webhook signing secret."
        : n.includes("client") || n.includes("oauth")
          ? "Linear OAuth application credential (linear.app/settings/api/applications)."
          : "Linear API key for tooling/provenance.",
  },
  {
    id: "github-app",
    test: (n) => n.includes("github-app"),
    url: "https://github.com/settings/apps",
    describe: (n) =>
      n.includes("private-key")
        ? "GitHub App private key (.pem) for signing app JWTs — regenerate under the app's settings."
        : n.includes("webhook")
          ? "GitHub App webhook signing secret."
          : "GitHub App OAuth credential for the data-connector flow.",
  },
  {
    id: "google",
    test: (n) => n.includes("google") || n.includes("bigquery"),
    url: "https://console.cloud.google.com/apis/credentials",
    describe: (n) => {
      const svc =
        /calendar|gmail|drive|docs|sheets|slides|meet|contacts|bigquery|admin|connections|internal|website/.exec(
          n,
        )?.[0] ?? "login";
      return `Google OAuth client ${n.includes("secret") ? "secret" : "id"} for the ${svc} scope/surface.`;
    },
  },
  {
    id: "neo4j",
    test: (n) => n.includes("neo4j"),
    url: "https://console.neo4j.io/",
    describe: (n) =>
      n.includes("aura")
        ? "Neo4j Aura API credential for programmatic instance management."
        : `Neo4j ${/(uri|username|password|production)/.exec(n)?.[0] ?? "connection"} for the knowledge graph.`,
  },
  {
    id: "clickhouse",
    test: (n) => n.includes("clickhouse") || n.includes("clickpipes"),
    url: "https://clickhouse.cloud/",
    describe: (n) =>
      `ClickHouse ${/(url|user|password)/.exec(n)?.[0] ?? "credential"} for the telemetry store.`,
  },
  {
    id: "plaid",
    test: (n) => n.includes("plaid"),
    url: "https://dashboard.plaid.com/developers/keys",
    describe: (n) =>
      `Plaid ${n.includes("client-id") ? "client id" : "secret"} for the financial-data connector.`,
  },
  {
    id: "twilio",
    test: (n) => n.includes("twilio"),
    url: "https://console.twilio.com/",
    describe: () => "Twilio auth token for SMS/voice.",
  },
  {
    id: "zoom",
    test: (n) => n.includes("zoom"),
    url: "https://marketplace.zoom.us/user/build",
    describe: (n) =>
      n.includes("webhook")
        ? "Zoom webhook secret token."
        : `Zoom server-to-server OAuth ${/(account-id|client-id|client-secret)/.exec(n)?.[0] ?? "credential"}.`,
  },
  {
    id: "resend",
    test: (n) => n.includes("resend") || n.includes("smtp"),
    url: "https://resend.com/api-keys",
    describe: (n) =>
      n.includes("webhook")
        ? "Resend webhook signing secret."
        : "Resend API key, used as the SMTP password (re_…).",
  },
  {
    id: "posthog",
    test: (n) => n.includes("posthog"),
    url: "https://us.posthog.com/settings/project",
    describe: (n) =>
      n.includes("host")
        ? "PostHog ingestion host URL."
        : "PostHog project API key.",
  },
  {
    id: "vercel",
    test: (n) => n.includes("vercel"),
    url: "https://vercel.com/account/settings/tokens",
    describe: () =>
      "Vercel API token used by tooling to read/write project env vars.",
  },
  {
    id: "redis",
    test: (n) =>
      n.includes("redis") || n.includes("valkey") || n.includes("celery"),
    url: "https://console.upstash.com/",
    describe: (n) =>
      `Redis/Valkey ${n.includes("celery") ? "Celery broker/result URL" : "connection credential"}.`,
  },
  {
    id: "alloydb",
    test: (n) => n.includes("alloydb"),
    url: "https://console.cloud.google.com/alloydb",
    describe: () =>
      "AlloyDB server CA certificate for verified TLS connections.",
  },
  {
    id: "gotenberg",
    test: (n) => n.includes("gotenberg"),
    url: "https://gotenberg.dev/",
    describe: () => "Gotenberg service URL for HTML/Office → PDF conversion.",
  },
  {
    id: "postgres-pw",
    test: (n) => n.includes("postgres") || n.includes("pgadmin"),
    url: "https://console.cloud.google.com/security/secret-manager",
    describe: (n) =>
      `${n.includes("pgadmin") ? "pgAdmin" : "Postgres"} admin password.`,
  },
];

/** The resolved documentation for a secret. */
export interface SecretDoc {
  description: string;
  vendor_url: string;
}

/**
 * Derive the seed description + vendor_url for a GCP secret. Registry-first
 * (rich, already-maintained descriptions), then the provider table, then a
 * generic fallback. A CLI mint command is appended when applicable.
 */
export function docFor(gcpName: string, envKey: string | null): SecretDoc {
  const n = gcpName.toLowerCase();
  const cli = cliGenCommand(gcpName);

  // Registry description wins — but pair it with a provider vendor_url.
  const provider = PROVIDERS.find((p) => p.test(n));
  let description = "";
  if (envKey && ENV_REGISTRY[envKey]?.description) {
    description = ENV_REGISTRY[envKey].description;
  } else if (provider) {
    description = provider.describe(n);
  } else {
    description = `Secret "${humanize(gcpName)}".`;
  }
  if (cli && !description.includes("openssl")) description += ` ${cli}`;

  const vendor_url =
    provider?.url ??
    "https://console.cloud.google.com/security/secret-manager?project=oxagen-490023";

  return { description, vendor_url };
}

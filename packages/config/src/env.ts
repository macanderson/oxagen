import { z } from "zod";

// Apps subset the global schema via `requiredEnv` and re-validate at boot.
// Spec §11: missing required vars fail closed, no silent defaults beyond
// what's marked optional here.
const envSchema = z.object({
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

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),

  STRIPE_SECRET_KEY: z.string().startsWith("sk_"),
  STRIPE_PUBLISHABLE_KEY: z.string().startsWith("pk_"),
  STRIPE_WEBHOOK_SECRET: z.string().startsWith("whsec_"),

  INNGEST_EVENT_KEY: z.string().optional(),
  INNGEST_SIGNING_KEY: z.string().optional(),

  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),

  LINEAR_API_KEY: z.string().optional(),

  NEXT_PUBLIC_APP_URL: z.string().url(),
  NEXT_PUBLIC_API_URL: z.string().url(),
});

export type Env = z.infer<typeof envSchema>;
export type EnvKey = keyof Env;

let cached: Env | null = null;

/**
 * Validate the entire env once at process start. Apps may also call
 * `requireEnv(["KEY1", "KEY2"])` for a subset check that throws early.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export function requireEnv<K extends EnvKey>(keys: readonly K[]): Pick<Env, K> {
  const env = loadEnv();
  const missing = keys.filter((k) => env[k] === undefined || env[k] === "");
  if (missing.length) {
    throw new Error(`Missing required env: ${missing.join(", ")}`);
  }
  return keys.reduce(
    (acc, k) => {
      acc[k] = env[k];
      return acc;
    },
    {} as Pick<Env, K>,
  );
}

// Reset for tests only.
export function __resetEnvCacheForTests(): void {
  cached = null;
}

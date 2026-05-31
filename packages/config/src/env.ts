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

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),

  STRIPE_SECRET_KEY: z.string().startsWith("sk_"),
  STRIPE_PUBLISHABLE_KEY: z.string().startsWith("pk_"),
  STRIPE_WEBHOOK_SECRET: z.string().startsWith("whsec_"),
  // Bug fix (b): client-side billing components read the NEXT_PUBLIC_ prefixed
  // name; the server keeps the unprefixed key for server-only routes.
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: z.string().startsWith("pk_").optional(),

  // OXA-1349: INNGEST keys are optional in base schema.
  // @oxagen/inngest-functions enforces required-in-production itself.
  INNGEST_EVENT_KEY: z.string().optional(),
  INNGEST_SIGNING_KEY: z.string().optional(),

  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),

  LINEAR_API_KEY: z.string().optional(),

  NEXT_PUBLIC_APP_URL: z.string().url(),
  NEXT_PUBLIC_API_URL: z.string().url(),

  // OXA-1348: when true (default off in prod), agent.code.execute is
  // materialized as an agent tool. Set true on Vercel once the Modal
  // runner is deployed (see ops/modal/README.md).
  SANDBOX_ENABLED: z
    .union([z.literal("true"), z.literal("false")])
    .optional()
    .transform((v) => v === "true"),
  // Driver selection for @oxagen/sandbox. `modal` routes through the
  // hosted Firecracker runner; `docker` runs Dockerode locally. Unset
  // = auto-detect (modal if MODAL_RUNNER_URL is present, else docker).
  SANDBOX_DRIVER: z.enum(["modal", "docker"]).optional(),
  MODAL_RUNNER_URL: z.string().url().optional(),
  MODAL_RUNNER_TOKEN: z.string().min(16).optional(),

  // OXA-1420: KMS CMK used to wrap OAuth token data encryption keys.
  // Required in production; optional in development/test so local dev
  // doesn't require live AWS credentials.  The crypto package enforces
  // presence at call-time when a real KMS client is provided.
  AUTH_TOKEN_KMS_KEY_ID: z.string().min(1).optional(),
});

// The exact set of keys this schema validates. `normalizeEnv` only ever
// touches these — never arbitrary env vars another tool may have set.
const KNOWN_ENV_KEYS: ReadonlySet<string> = new Set(Object.keys(baseEnvSchema.shape));

// Full schema — no production superRefine here; @oxagen/inngest-functions
// enforces the INNGEST key requirement locally so callers that don't use
// Inngest are not forced to provide those vars.
const envSchema = baseEnvSchema;

export type Env = z.infer<typeof envSchema>;
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
    if (
      KNOWN_ENV_KEYS.has(key) &&
      typeof value === "string" &&
      value.length >= 2 &&
      value.startsWith('"') &&
      value.endsWith('"')
    ) {
      out[key] = value.slice(1, -1);
      stripped.push(key);
    } else {
      out[key] = value;
    }
  }
  if (stripped.length > 0) {
    console.warn(
      `[config] normalizeEnv stripped surrounding double-quotes from: ${stripped.join(", ")}. ` +
        `These values are double-quoted at the source (e.g. the Vercel dashboard) — fix them there.`,
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
  const parsed = envSchema.safeParse(normalizeEnv(source));
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

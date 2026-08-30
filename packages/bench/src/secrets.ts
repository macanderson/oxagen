// Defensive guard against a secret VALUE landing in bench.benchmark_run.config
// / .conditions (or the per-task equivalents) — a shared ClickHouse store
// queried by anyone with bench read access. The replay contract only ever
// stores env var NAMES ("AI_GATEWAY_API_KEY"), never values, so this catches
// the conventional shape mistake (`{apiKey: process.env.AI_GATEWAY_API_KEY}`)
// before it reaches ClickHouse. Not a substitute for care at the call site —
// a value that happens to look like an env var name would slip through — but
// it turns the common mistake into a loud ingest-time failure instead of a
// silent leak.

const SECRET_KEY_PATTERN = /(api[_-]?key|secret|password|token|credential)/i;

/** All-caps upper-snake-case, e.g. "AI_GATEWAY_API_KEY" — an env var NAME, not a value. */
const ENV_VAR_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/**
 * Throws if `payload` carries a string value under a secret-shaped key
 * (api_key, secret, password, token, credential — case-insensitive) that
 * isn't itself an env-var-name-shaped placeholder. Recurses into nested
 * plain objects; does not descend into arrays (bench config payloads don't
 * nest secrets inside arrays today, and scanning them would risk false
 * positives on legitimate string lists like `taskIds`).
 */
export function assertNoSecretValues(
  payload: Record<string, unknown>,
  path = "",
): void {
  for (const [key, value] of Object.entries(payload)) {
    const fullPath = path ? `${path}.${key}` : key;
    if (typeof value === "string") {
      if (
        SECRET_KEY_PATTERN.test(key) &&
        value.length > 0 &&
        !ENV_VAR_NAME_PATTERN.test(value)
      ) {
        throw new Error(
          `bench ingest: refusing to store a likely secret value at "${fullPath}" — ` +
            `store the env var NAME (e.g. "AI_GATEWAY_API_KEY"), never its value`,
        );
      }
    } else if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      assertNoSecretValues(value as Record<string, unknown>, fullPath);
    }
  }
}

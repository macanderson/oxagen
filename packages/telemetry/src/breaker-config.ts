/**
 * breaker-config.ts — resolves the shared, env-configured circuit-breaker
 * thresholds once, so every per-dependency breaker (Neo4j / Stripe / ClickHouse)
 * trips with the same conservative, operator-tunable policy.
 *
 * Kept separate from both `circuit-breaker.ts` (which stays dependency-free /
 * pure) and `clickhouse.ts` / `breaker-clients.ts` so those can share it without
 * a circular import.
 */
import { requireEnv } from "@oxagen/config/env";
import type { CircuitBreakerOptions } from "./circuit-breaker";

export type BreakerThresholds = Required<
  Pick<
    CircuitBreakerOptions,
    "failureThreshold" | "resetTimeoutMs" | "successThreshold"
  >
>;

/**
 * Read the global breaker thresholds from the validated env (defaults live in
 * `@oxagen/config` `baseEnvSchema`: 5 failures / 30s reset / 1 probe success).
 */
export function breakerEnvConfig(): BreakerThresholds {
  const env = requireEnv([
    "CIRCUIT_BREAKER_FAILURE_THRESHOLD",
    "CIRCUIT_BREAKER_RESET_TIMEOUT_MS",
    "CIRCUIT_BREAKER_SUCCESS_THRESHOLD",
  ] as const);
  return {
    failureThreshold: env.CIRCUIT_BREAKER_FAILURE_THRESHOLD,
    resetTimeoutMs: env.CIRCUIT_BREAKER_RESET_TIMEOUT_MS,
    successThreshold: env.CIRCUIT_BREAKER_SUCCESS_THRESHOLD,
  };
}

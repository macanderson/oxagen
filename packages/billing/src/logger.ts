import pino from "pino";

/**
 * Structured logger for the billing package.
 *
 * Fields carried on every log line:
 *   app       = "billing"
 *   level     = LOG_LEVEL env (default "info")
 *
 * Instrumentation convention — billing/metering paths include:
 *   orgId, amountCents, durationMs, surface
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "billing" },
});

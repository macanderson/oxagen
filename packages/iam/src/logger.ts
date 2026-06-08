import pino from "pino";

/**
 * Structured logger for the iam package.
 *
 * Fields carried on every log line:
 *   app       = "iam"
 *   level     = LOG_LEVEL env (default "info")
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "iam" },
});

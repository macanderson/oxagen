import pino from "pino";

/**
 * Structured logger for the auth layer. Level defaults to "info" (via
 * LOG_LEVEL). Mirrors packages/database/src/logger.ts and the other
 * per-package pino loggers so auth-hook failures land in the same structured
 * stream (queryable fields, no bare stderr strings) rather than a
 * fire-once console.error that is easy to lose in production log aggregation.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "auth" },
});

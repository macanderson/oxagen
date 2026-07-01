import pino from "pino";

/**
 * Structured logger for the database layer. Level defaults to "info" (via
 * LOG_LEVEL), so debug-level lines — e.g. the per-call unscoped-DB-access
 * signal in unscoped-meter.ts — stay off in normal dev output but remain
 * queryable by setting LOG_LEVEL=debug. Mirrors packages/handlers/src/logger.ts.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "database" },
});

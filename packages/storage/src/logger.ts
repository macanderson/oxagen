import pino from "pino";

/**
 * Structured logger for the storage package.
 *
 * Every storage op logs driver, key, contentType, bytes, and durationMs
 * so blob throughput and latency are observable.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "storage" },
});

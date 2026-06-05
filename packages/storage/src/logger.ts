import pino from "pino";

/**
 * Structured logger for the storage package.
 *
 * Instrumentation convention — every storage op logs:
 *   driver, key, contentType, bytes, durationMs
 * so blob throughput and latency are observable per [[instrument-everything]].
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "storage" },
});

import pino from "pino";

/**
 * Structured logger for the notifications package.
 *
 * Instrumentation convention — every send logs:
 *   driver, to, subject, accepted, rejected, durationMs, outcome
 * so email throughput, latency, and failures are observable per
 * [[instrument-everything]]. Never log the message body, headers, or any other
 * PII — only recipient addresses, the subject, and aggregate counts.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "notifications" },
});

import pino from "pino";

/**
 * Structured logger for the notifications package.
 *
 * Every send logs driver, recipient count, subject, accepted/rejected counts,
 * duration, and outcome — never the message body or headers.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "notifications" },
});

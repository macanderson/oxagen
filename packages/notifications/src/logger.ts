import pino from "pino";

/**
 * Structured logger for the notifications package.
 *
 * Every send logs driver, recipient count, subject, accepted/rejected counts,
 * duration, and outcome. The message body and headers are never logged. The
 * recipient address is not logged on the success path, but the fire-and-forget
 * and notifyOrgManagers failure paths do include it — see the README.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "notifications" },
});

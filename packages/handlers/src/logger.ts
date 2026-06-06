import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "handlers" },
});

/**
 * Mask an email address for logging. Email is PII (SOC 2 CC6 / GDPR data
 * minimization) — never emit a raw address to the log aggregator. Keeps the
 * first character and domain so logs stay useful for triage (`j***@acme.com`);
 * the audit trail records the actor by userId, not email.
 */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  const head = email[0] ?? "";
  return `${head}***@${email.slice(at + 1)}`;
}

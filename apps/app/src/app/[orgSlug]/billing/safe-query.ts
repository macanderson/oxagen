import { logger } from "@oxagen/handlers/logger";

/**
 * Wraps a DB query so that a failure returns a safe fallback instead of
 * throwing. Errors are always logged via the shared logger so they remain
 * observable (connection loss, schema mismatch, etc.) even when the UI
 * degrades gracefully.
 */
export const safeQuery = async <T>(
  fn: () => Promise<T>,
  fallback: T,
): Promise<T> => {
  try {
    return await fn();
  } catch (err) {
    logger.error({ err }, "billing: safeQuery failed");
    return fallback;
  }
};

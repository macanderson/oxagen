import type { CapabilityHandler } from "@oxagen/oxagen";
import { userPreferencesGet } from "@oxagen/oxagen/contracts/user.preferences.get";
// user_preferences is user-global (no org_id, no RLS policy) — withSystemDb is correct.
import { schema, withSystemDb } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

export const userPreferencesGetHandler: CapabilityHandler<typeof userPreferencesGet> = async (
  _input,
  ctx,
) => {
  if (!ctx.userId) {
    logger.warn({}, "user.preferences.get: rejected — no authenticated user");
    throw new Error("user.preferences.get requires an authenticated user");
  }

  const userId = ctx.userId;

  const row = await withSystemDb((tx) =>
    tx.query.userPreferences.findFirst({
      where: eq(schema.userPreferences.userId, userId),
      columns: {
        theme: true,
        language: true,
        timezone: true,
        notificationSettings: true,
      },
    }),
  );

  if (!row) {
    logger.info(
      { userId, surface: ctx.surface },
      "user.preferences.get: no row — returning defaults",
    );
    return {
      theme: "system",
      language: "en",
      timezone: "UTC",
      notification_settings: {},
    };
  }

  logger.info(
    { userId, surface: ctx.surface },
    "user.preferences.get: returned preferences",
  );

  return {
    theme: row.theme,
    language: row.language,
    timezone: row.timezone,
    notification_settings: row.notificationSettings as Record<string, unknown>,
  };
};

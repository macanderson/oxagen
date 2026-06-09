import type { CapabilityHandler } from "@oxagen/oxagen";
import { userPreferencesUpdate } from "@oxagen/oxagen/contracts/user.preferences.update";
// user_preferences is user-global (no org_id, no RLS policy) — withSystemDb is correct.
import { schema, withSystemDb } from "@oxagen/database";
import type { NewUserPreferences } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

export const userPreferencesUpdateHandler: CapabilityHandler<typeof userPreferencesUpdate> = async (
  input,
  ctx,
) => {
  if (!ctx.userId) {
    logger.warn({}, "user.preferences.update: rejected — no authenticated user");
    throw new Error("user.preferences.update requires an authenticated user");
  }

  const userId = ctx.userId;

  // Build the insert values — non-nullable columns need a value even on first
  // insert. They have DB defaults but Drizzle's insert type requires them at
  // the TS layer; fall back to schema defaults so the upsert is always valid.
  const insertValues: NewUserPreferences = {
    userId,
    createdByUserId: userId,
    updatedByUserId: userId,
    // UI prefs: schema defaults keep existing behaviour on first-ever insert.
    fontSize: "medium",
    density: "comfortable",
    enterToSubmit: false,
    pendingPromptBehavior: "queue",
    // Account-level prefs: provided value or schema default.
    theme: input.theme ?? "system",
    language: input.language ?? "en",
    timezone: input.timezone ?? "UTC",
  };

  // Partial update set — only update the provided fields plus the audit column.
  const updateSet: Partial<NewUserPreferences> & { updatedByUserId: string } = {
    updatedByUserId: userId,
  };

  if (input.theme !== undefined) updateSet.theme = input.theme;
  if (input.language !== undefined) updateSet.language = input.language;
  if (input.timezone !== undefined) updateSet.timezone = input.timezone;

  await withSystemDb((tx) =>
    tx
      .insert(schema.userPreferences)
      .values(insertValues)
      .onConflictDoUpdate({
        target: schema.userPreferences.userId,
        set: updateSet,
      }),
  );

  // Re-read the full row to return canonical post-upsert state.
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
    throw new Error("user.preferences.update: upserted row not found on re-read");
  }

  logger.info(
    { userId, surface: ctx.surface },
    "user.preferences.update: preferences updated",
  );

  return {
    theme: row.theme,
    language: row.language,
    timezone: row.timezone,
    notification_settings: row.notificationSettings as Record<string, unknown>,
  };
};

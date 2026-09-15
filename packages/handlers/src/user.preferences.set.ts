// set_preferences: the Account dialog's Preferences tab. A partial upsert on
// auth.user_preferences, which is user-global (no org_id, no RLS policy), so
// withSystemDb is the right executor. The answer is the whole account set
// after the write, read back from the row rather than echoed from the input.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import { userPreferencesSet } from "@oxagen/oxagen/contracts/user.preferences.set";
import {
  schema,
  withSystemDb,
  type NewUserPreferences,
} from "@oxagen/database";
import { eq } from "drizzle-orm";

export const userPreferencesSetHandler: CapabilityHandler<
  typeof userPreferencesSet
> = async (input, ctx) => {
  if (!ctx.userId) {
    throw new HandlerError({ code: "forbidden", reason: "no_principal" });
  }
  const userId = ctx.userId;

  const insertValues: NewUserPreferences = {
    userId,
    createdByUserId: userId,
    updatedByUserId: userId,
    language: input.locale ?? "en",
    theme: input.theme ?? "system",
    timezone: input.timezone ?? "UTC",
  };
  const updateSet: Partial<NewUserPreferences> & { updatedByUserId: string } = {
    updatedByUserId: userId,
    ...(input.locale !== undefined ? { language: input.locale } : {}),
    ...(input.theme !== undefined ? { theme: input.theme } : {}),
    ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
  };

  const row = await withSystemDb(async (tx) => {
    await tx
      .insert(schema.userPreferences)
      .values(insertValues)
      .onConflictDoUpdate({
        target: schema.userPreferences.userId,
        set: updateSet,
      });
    const [after] = await tx
      .select({
        language: schema.userPreferences.language,
        theme: schema.userPreferences.theme,
        timezone: schema.userPreferences.timezone,
      })
      .from(schema.userPreferences)
      .where(eq(schema.userPreferences.userId, userId))
      .limit(1);
    return after;
  });
  if (!row) {
    throw new HandlerError({
      code: "not_found",
      reason: "preferences_row_missing",
    });
  }
  return {
    locale: row.language,
    theme: row.theme === "light" || row.theme === "dark" ? row.theme : "system",
    timezone: row.timezone,
  };
};

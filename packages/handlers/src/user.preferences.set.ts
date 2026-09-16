// set_preferences: the Account dialog's Preferences tab, and the ONE writer of
// auth.user_preferences (ADR-069). Every field get_user_preferences returns is
// settable here; a preference the product reads and nothing can write is a dead
// value. A partial upsert: a field the caller omits keeps its stored value, and
// an explicit null on the two nullable model columns clears the preference.
// The row is user-global (no org_id, no RLS policy), so withSystemDb is the
// right executor. The answer is the whole set after the write, read back from
// the row rather than echoed from the input.
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

  // First insert: every non-nullable column needs a value, so an omitted field
  // takes the same default the column carries. The two nullable model columns
  // are set only when the caller named them, so an omitted field leaves NULL.
  const insertValues: NewUserPreferences = {
    userId,
    createdByUserId: userId,
    updatedByUserId: userId,
    language: input.locale ?? "en",
    theme: input.theme ?? "system",
    timezone: input.timezone ?? "UTC",
    fontSize: input.fontSize ?? "medium",
    density: input.density ?? "comfortable",
    enterToSubmit: input.enterToSubmit ?? false,
    pendingPromptBehavior: input.pendingPromptBehavior ?? "queue",
    ...("defaultTextTier" in input
      ? { defaultTextTier: input.defaultTextTier }
      : {}),
    ...("defaultTextModel" in input
      ? { defaultTextModel: input.defaultTextModel }
      : {}),
  };

  // The update half is strictly the fields the caller named. `in input` rather
  // than `!== undefined` for the nullable pair: null is a value (clear it),
  // undefined is an absence (leave it), and the two must not collapse.
  const updateSet: Partial<NewUserPreferences> & { updatedByUserId: string } = {
    updatedByUserId: userId,
    ...(input.locale !== undefined ? { language: input.locale } : {}),
    ...(input.theme !== undefined ? { theme: input.theme } : {}),
    ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
    ...(input.fontSize !== undefined ? { fontSize: input.fontSize } : {}),
    ...(input.density !== undefined ? { density: input.density } : {}),
    ...(input.enterToSubmit !== undefined
      ? { enterToSubmit: input.enterToSubmit }
      : {}),
    ...(input.pendingPromptBehavior !== undefined
      ? { pendingPromptBehavior: input.pendingPromptBehavior }
      : {}),
    ...("defaultTextTier" in input
      ? { defaultTextTier: input.defaultTextTier }
      : {}),
    ...("defaultTextModel" in input
      ? { defaultTextModel: input.defaultTextModel }
      : {}),
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
        fontSize: schema.userPreferences.fontSize,
        density: schema.userPreferences.density,
        enterToSubmit: schema.userPreferences.enterToSubmit,
        pendingPromptBehavior: schema.userPreferences.pendingPromptBehavior,
        defaultTextTier: schema.userPreferences.defaultTextTier,
        defaultTextModel: schema.userPreferences.defaultTextModel,
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
    fontSize: row.fontSize,
    density: row.density,
    enterToSubmit: row.enterToSubmit,
    pendingPromptBehavior: row.pendingPromptBehavior,
    defaultTextTier: row.defaultTextTier ?? null,
    defaultTextModel: row.defaultTextModel ?? null,
  };
};

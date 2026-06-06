import type { CapabilityHandler } from "@oxagen/oxagen";
import { userPreferencesWrite } from "@oxagen/oxagen/contracts/user.preferences.write";
// user_preferences is user-global (no org_id, no RLS policy) — withSystemDb is correct.
import { schema, withSystemDb } from "@oxagen/database";
import type { NewUserPreferences } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

export const userPreferencesWriteHandler: CapabilityHandler<typeof userPreferencesWrite> = async (
  input,
  ctx,
) => {
  if (!ctx.userId) {
    logger.warn({}, "user.preferences.write: rejected — no authenticated user");
    throw new Error("user.preferences.write requires an authenticated user");
  }

  const userId = ctx.userId;

  // Build the typed insert values. Required fields get their provided value or
  // fall back to the schema default so the upsert is always valid on first insert.
  const insertValues: NewUserPreferences = {
    userId,
    createdByUserId: userId,
    updatedByUserId: userId,
    // Non-nullable columns: use provided value or schema default on first insert.
    fontSize: input.fontSize ?? "medium",
    density: input.density ?? "comfortable",
    enterToSubmit: input.enterToSubmit ?? false,
    pendingPromptBehavior: input.pendingPromptBehavior ?? "queue",
    // Nullable model columns: undefined → not set on first insert (column default NULL).
    ...("defaultTextTier" in input ? { defaultTextTier: input.defaultTextTier } : {}),
    ...("defaultTextModel" in input ? { defaultTextModel: input.defaultTextModel } : {}),
    ...("defaultImageModel" in input ? { defaultImageModel: input.defaultImageModel } : {}),
    ...("defaultVideoModel" in input ? { defaultVideoModel: input.defaultVideoModel } : {}),
  };

  // Build the partial update set — only update fields that were explicitly provided.
  // "not provided" leaves the existing column value unchanged.
  const updateSet: Partial<NewUserPreferences> & { updatedByUserId: string } = {
    updatedByUserId: userId,
  };

  if (input.fontSize !== undefined) updateSet.fontSize = input.fontSize;
  if (input.density !== undefined) updateSet.density = input.density;
  if (input.enterToSubmit !== undefined) updateSet.enterToSubmit = input.enterToSubmit;
  if (input.pendingPromptBehavior !== undefined)
    updateSet.pendingPromptBehavior = input.pendingPromptBehavior;
  if ("defaultTextTier" in input) updateSet.defaultTextTier = input.defaultTextTier;
  if ("defaultTextModel" in input) updateSet.defaultTextModel = input.defaultTextModel;
  if ("defaultImageModel" in input) updateSet.defaultImageModel = input.defaultImageModel;
  if ("defaultVideoModel" in input) updateSet.defaultVideoModel = input.defaultVideoModel;

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
        fontSize: true,
        density: true,
        enterToSubmit: true,
        pendingPromptBehavior: true,
        defaultTextTier: true,
        defaultTextModel: true,
        defaultImageModel: true,
        defaultVideoModel: true,
      },
    }),
  );

  if (!row) {
    // Should never happen — we just upserted.
    throw new Error("user.preferences.write: upserted row not found on re-read");
  }

  logger.info(
    { userId, surface: ctx.surface },
    "user.preferences.write: preferences updated",
  );

  return {
    fontSize: row.fontSize,
    density: row.density,
    enterToSubmit: row.enterToSubmit,
    pendingPromptBehavior: row.pendingPromptBehavior,
    defaultTextTier: row.defaultTextTier ?? null,
    defaultTextModel: row.defaultTextModel ?? null,
    defaultImageModel: row.defaultImageModel ?? null,
    defaultVideoModel: row.defaultVideoModel ?? null,
  };
};

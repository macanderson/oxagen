import type { CapabilityHandler } from "@oxagen/oxagen";
import { userPreferencesRead } from "@oxagen/oxagen/contracts/user.preferences.read";
// user_preferences is user-global (no org_id, no RLS policy) — withSystemDb is correct.
import { schema, withSystemDb } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

/** Schema defaults returned when no preferences row exists for the caller. */
const PREF_DEFAULTS = {
  fontSize: "medium" as const,
  density: "comfortable" as const,
  enterToSubmit: false,
  pendingPromptBehavior: "queue" as const,
  defaultTextTier: null,
  defaultTextModel: null,
  defaultImageModel: null,
  defaultVideoModel: null,
};

export const userPreferencesReadHandler: CapabilityHandler<typeof userPreferencesRead> = async (
  _input,
  ctx,
) => {
  if (!ctx.userId) {
    logger.warn({}, "user.preferences.read: rejected — no authenticated user");
    throw new Error("user.preferences.read requires an authenticated user");
  }

  const userId = ctx.userId;

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
    logger.info(
      { userId: ctx.userId, surface: ctx.surface },
      "user.preferences.read: no row — returning schema defaults",
    );
    return PREF_DEFAULTS;
  }

  logger.info(
    { userId: ctx.userId, surface: ctx.surface },
    "user.preferences.read: returned preferences",
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

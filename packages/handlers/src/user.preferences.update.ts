import type { CapabilityHandler } from "@oxagen/oxagen";
import { userPreferencesUpdate } from "@oxagen/oxagen/contracts/user.preferences.update";

export const userPreferencesUpdateHandler: CapabilityHandler<typeof userPreferencesUpdate> = async (
  input,
  ctx,
) => {
  console.log(`[stub] user.preferences.update for user ${ctx.userId}`, input);
  return {
    theme: input.theme ?? "system",
    language: input.language ?? "en",
    timezone: input.timezone ?? "UTC",
    notification_settings: {},
  };
};

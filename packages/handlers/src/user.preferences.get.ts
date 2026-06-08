import type { CapabilityHandler } from "@oxagen/oxagen";
import { userPreferencesGet } from "@oxagen/oxagen/contracts/user.preferences.get";

export const userPreferencesGetHandler: CapabilityHandler<typeof userPreferencesGet> = async (
  _input,
  ctx,
) => {
  console.log(`[stub] user.preferences.get for user ${ctx.userId}`);
  return {
    theme: "system",
    language: "en",
    timezone: "UTC",
    notification_settings: {},
  };
};

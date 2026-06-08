import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";

interface UserPreferencesUpdateResponse {
  theme: string;
  language: string;
  timezone: string;
  notification_settings: Record<string, unknown>;
}

export const userPreferencesUpdateCommand = new Command("update")
  .description("Update current user preferences")
  .option("-t, --theme <theme>", "UI theme (e.g. light, dark, system)")
  .option("-l, --language <language>", "Preferred language (e.g. en, fr)")
  .option("-z, --timezone <timezone>", "Preferred timezone (e.g. America/New_York)")
  .action(async (options: { theme?: string; language?: string; timezone?: string }) => {
    try {
      if (!options.theme && !options.language && !options.timezone) {
        throw new Error("At least one of --theme, --language, or --timezone is required");
      }
      const body: Record<string, string> = {};
      if (options.theme) body.theme = options.theme;
      if (options.language) body.language = options.language;
      if (options.timezone) body.timezone = options.timezone;

      console.log("Updating user preferences...");
      const data = await apiRequest<UserPreferencesUpdateResponse>(
        "/user/preferences/update",
        {
          method: "POST",
          body: JSON.stringify(body),
        }
      );
      console.log(`✓ Preferences updated`);
      console.log(`  Theme:    ${data.theme}`);
      console.log(`  Language: ${data.language}`);
      console.log(`  Timezone: ${data.timezone}`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

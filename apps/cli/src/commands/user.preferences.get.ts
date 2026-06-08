import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";

interface UserPreferencesGetResponse {
  theme: string;
  language: string;
  timezone: string;
  notification_settings: Record<string, unknown>;
}

export const userPreferencesGetCommand = new Command("get")
  .description("Get current user preferences")
  .action(async () => {
    try {
      const data = await apiRequest<UserPreferencesGetResponse>(
        "/user/preferences/get",
        { method: "GET" }
      );
      console.log(`✓ User preferences`);
      console.log(`  Theme:    ${data.theme}`);
      console.log(`  Language: ${data.language}`);
      console.log(`  Timezone: ${data.timezone}`);
      console.log(`  Notifications: ${JSON.stringify(data.notification_settings)}`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

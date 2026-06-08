import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";

interface UserPreferencesReadResponse {
  fontSize: "small" | "medium" | "large";
  density: "compact" | "comfortable" | "spacious";
  enterToSubmit: boolean;
  pendingPromptBehavior: "queue" | "interrupt";
  defaultTextTier: "fast" | "balanced" | "precise" | null;
  defaultTextModel: string | null;
  defaultImageModel: string | null;
  defaultVideoModel: string | null;
}

export const userPreferencesReadCommand = new Command("read")
  .description("Read the calling user's UI and model preferences")
  .action(async () => {
    try {
      const data = await apiRequest<UserPreferencesReadResponse>("/user/preferences/read", {
        method: "GET",
      });
      console.log(`User preferences:`);
      console.log(`  Font size:        ${data.fontSize}`);
      console.log(`  Density:          ${data.density}`);
      console.log(`  Enter to submit:  ${data.enterToSubmit}`);
      console.log(`  Pending prompts:  ${data.pendingPromptBehavior}`);
      if (data.defaultTextTier) console.log(`  Default tier:     ${data.defaultTextTier}`);
      if (data.defaultTextModel) console.log(`  Text model:       ${data.defaultTextModel}`);
      if (data.defaultImageModel) console.log(`  Image model:      ${data.defaultImageModel}`);
      if (data.defaultVideoModel) console.log(`  Video model:      ${data.defaultVideoModel}`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

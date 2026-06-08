import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";

interface UserPreferencesWriteResponse {
  fontSize: "small" | "medium" | "large";
  density: "compact" | "comfortable" | "spacious";
  enterToSubmit: boolean;
  pendingPromptBehavior: "queue" | "interrupt";
  defaultTextTier: "fast" | "balanced" | "precise" | null;
  defaultTextModel: string | null;
  defaultImageModel: string | null;
  defaultVideoModel: string | null;
}

export const userPreferencesWriteCommand = new Command("write")
  .description("Update the calling user's UI and model preferences (partial update)")
  .option("--font-size <size>", "Font size: small, medium, or large")
  .option("--density <density>", "Density: compact, comfortable, or spacious")
  .option("--enter-to-submit <bool>", "Enter to submit (true/false)")
  .option("--pending-behavior <behavior>", "Pending prompt behavior: queue or interrupt")
  .option("--text-tier <tier>", "Default text tier: fast, balanced, or precise")
  .option("--text-model <model>", "Default text model slug (or 'null' to clear)")
  .option("--image-model <model>", "Default image model slug (or 'null' to clear)")
  .option("--video-model <model>", "Default video model slug (or 'null' to clear)")
  .action(async (options: {
    fontSize?: string;
    density?: string;
    enterToSubmit?: string;
    pendingBehavior?: string;
    textTier?: string;
    textModel?: string;
    imageModel?: string;
    videoModel?: string;
  }) => {
    try {
      const body: Record<string, unknown> = {};
      if (options.fontSize) body.fontSize = options.fontSize;
      if (options.density) body.density = options.density;
      if (options.enterToSubmit !== undefined) body.enterToSubmit = options.enterToSubmit !== "false";
      if (options.pendingBehavior) body.pendingPromptBehavior = options.pendingBehavior;
      if (options.textTier) body.defaultTextTier = options.textTier === "null" ? null : options.textTier;
      if (options.textModel) body.defaultTextModel = options.textModel === "null" ? null : options.textModel;
      if (options.imageModel) body.defaultImageModel = options.imageModel === "null" ? null : options.imageModel;
      if (options.videoModel) body.defaultVideoModel = options.videoModel === "null" ? null : options.videoModel;

      const data = await apiRequest<UserPreferencesWriteResponse>("/user/preferences/write", {
        method: "POST",
        body: JSON.stringify(body),
      });
      console.log(`✓ Preferences updated`);
      console.log(`  Font size:       ${data.fontSize}`);
      console.log(`  Density:         ${data.density}`);
      console.log(`  Enter to submit: ${data.enterToSubmit}`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

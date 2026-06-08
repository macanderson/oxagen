import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";

export const videoGenerateCommand = new Command("generate")
  .description("Generate a video from a prompt")
  .requiredOption("-p, --prompt <text>", "Video generation prompt")
  .option("-d, --duration <n>", "Duration in seconds (1-60)", "10")
  .option("-m, --model <model>", "Model to use", "veo-3.0")
  .option("-a, --async", "Run asynchronously")
  .action(async (options: Record<string, unknown>) => {
    try {
      const result = await apiRequest("/video/generate", {
        method: "POST",
        body: JSON.stringify({
          prompt: options.prompt,
          duration: parseInt(String(options.duration), 10),
          model: options.model,
          async: options.async || false,
        }),
      });
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error("Failed to generate video:", error);
      process.exit(1);
    }
  });

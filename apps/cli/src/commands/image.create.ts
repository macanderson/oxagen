import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";

interface ImageCreateResponse {
  image_id: string;
  url: string;
  created_at: string;
}

export const imageCreateCommand = new Command("create")
  .description("Generate an image from a prompt")
  .requiredOption("-p, --prompt <text>", "Image generation prompt")
  .option("--model <model>", "Model to use (gpt-image-1|flux-2-max)", "gpt-image-1")
  .option("-s, --size <size>", "Image size (e.g. 1024x1024)")
  .action(async (options: { prompt: string; model?: string; size?: string }) => {
    try {
      if (options.model && !["gpt-image-1", "flux-2-max"].includes(options.model)) {
        throw new Error("Model must be one of: gpt-image-1, flux-2-max");
      }
      console.log(`Generating image with ${options.model ?? "gpt-image-1"}...`);
      const data = await apiRequest<ImageCreateResponse>(
        "/image/create",
        {
          method: "POST",
          body: JSON.stringify({
            prompt: options.prompt,
            model: options.model ?? "gpt-image-1",
            size: options.size,
          }),
        }
      );
      console.log(`✓ Image created`);
      console.log(`  ID:         ${data.image_id}`);
      console.log(`  URL:        ${data.url}`);
      console.log(`  Created at: ${data.created_at}`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

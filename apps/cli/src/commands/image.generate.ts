import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";
import * as fs from "fs";

interface ImageGenerateResponse {
  url: string;
  [key: string]: unknown;
}

export const imageGenerateCommand = new Command("generate")
  .description("Generate an image from a prompt")
  .requiredOption("-p, --prompt <text>", "Image generation prompt")
  .option("-m, --model <model>", "Model to use", "gpt-image-1")
  .option("-o, --output <path>", "Output file path (auto-saved if provided)")
  .option("-a, --async", "Run asynchronously")
  .action(async (options: Record<string, unknown>) => {
    try {
      const result = await apiRequest<ImageGenerateResponse>("/image/generate", {
        method: "POST",
        body: JSON.stringify({
          prompt: options.prompt,
          model: options.model,
          async: options.async || false,
        }),
      });
      if (options.output && result.url) {
        const response = await fetch(result.url);
        const buffer = await response.arrayBuffer();
        fs.writeFileSync(String(options.output), Buffer.from(buffer));
        console.log(`Image saved to ${options.output}`);
      } else {
        console.log(JSON.stringify(result, null, 2));
      }
    } catch (error) {
      console.error("Failed to generate image:", error);
      process.exit(1);
    }
  });

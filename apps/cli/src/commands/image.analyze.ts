import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";

interface ImageAnalyzeResponse {
  analysis: string;
  tags: string[];
  description: string;
}

export const imageAnalyzeCommand = new Command("analyze")
  .description("Analyze an image by ID")
  .requiredOption("-i, --image <id>", "Image ID to analyze")
  .action(async (options: { image: string }) => {
    try {
      console.log(`Analyzing image ${options.image}...`);
      const data = await apiRequest<ImageAnalyzeResponse>("/image/analyze", {
        method: "POST",
        body: JSON.stringify({ image_id: options.image }),
      });
      console.log(`✓ Analysis complete`);
      console.log(`  Description: ${data.description}`);
      console.log(`  Tags: ${data.tags.join(", ")}`);
      console.log(`  Analysis: ${data.analysis}`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";
import * as fs from "fs";

interface SVGGenerateResponse {
  svg: string;
  [key: string]: unknown;
}

export const svgGenerateCommand = new Command("generate")
  .description("Generate an SVG from a description")
  .requiredOption("-d, --description <text>", "SVG description")
  .option("-o, --output <path>", "Output file path")
  .action(async (options: Record<string, unknown>) => {
    try {
      const result = await apiRequest<SVGGenerateResponse>("/svg/generate", {
        method: "POST",
        body: JSON.stringify({
          description: options.description,
        }),
      });
      if (options.output) {
        fs.writeFileSync(String(options.output), result.svg);
        console.log(`SVG written to ${options.output}`);
      } else {
        console.log(result.svg);
      }
    } catch (error) {
      console.error("Failed to generate SVG:", error);
      process.exit(1);
    }
  });

import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";
import * as fs from "fs";

interface MermaidGenerateResponse {
  title: string;
  source: string;
  render: {
    componentId: string;
    props: Record<string, unknown>;
  };
}

export const mermaidGenerateCommand = new Command("generate")
  .description("Generate a Mermaid diagram artifact")
  .requiredOption("-d, --diagram <source>", "Mermaid diagram source text")
  .requiredOption("-t, --title <title>", "Diagram title")
  .option(
    "--theme <theme>",
    "Mermaid theme: default | dark | neutral | forest (default: default)",
    "default",
  )
  .option("-o, --output <path>", "Write the diagram source to a file")
  .action(async (options: Record<string, unknown>) => {
    try {
      const result = await apiRequest<MermaidGenerateResponse>("/mermaid/generate", {
        method: "POST",
        body: JSON.stringify({
          title: options.title,
          diagram: options.diagram,
          theme: options.theme,
        }),
      });
      if (options.output) {
        fs.writeFileSync(String(options.output), result.source);
        console.log(`Diagram source written to ${options.output}`);
      } else {
        console.log(JSON.stringify(result, null, 2));
      }
    } catch (error) {
      console.error("Failed to generate Mermaid diagram:", error);
      process.exit(1);
    }
  });

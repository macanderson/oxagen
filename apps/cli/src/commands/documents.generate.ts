import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";

export const documentsGenerateCommand = new Command("generate")
  .description("Generate a document from a template or prompt")
  .requiredOption("-t, --template <name>", "Document template name")
  .requiredOption("-c, --context <json>", "Template context as JSON")
  .option("-o, --output <path>", "Output file path")
  .option("-a, --async", "Run asynchronously")
  .action(async (options: Record<string, unknown>) => {
    try {
      let context;
      try {
        context = JSON.parse(String(options.context));
      } catch (e) {
        console.error("Invalid JSON context:", options.context);
        process.exit(1);
      }
      const result = await apiRequest("/documents/generate", {
        method: "POST",
        body: JSON.stringify({
          template: options.template,
          context,
          async: options.async || false,
        }),
      });
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error("Failed to generate document:", error);
      process.exit(1);
    }
  });

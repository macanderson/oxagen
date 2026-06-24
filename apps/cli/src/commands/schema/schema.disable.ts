import { Command } from "commander";
import { apiRequest, requireAuth, ApiError } from "../../lib/api-client.js";

interface SchemaDisableOptions {
  json?: boolean;
}

export const schemaDisableCommand = new Command("disable")
  .description("Disable a schema")
  .argument("<schema-name>", "Schema name to disable")
  .option("--json", "Output raw JSON")
  .action(async (schemaName: string, _options: SchemaDisableOptions) => {
    requireAuth();
    try {
      const data = await apiRequest("/schema/toggle", {
        method: "POST",
        body: JSON.stringify({ schemaName, enabled: false }),
      });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

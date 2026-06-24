import { Command } from "commander";
import { apiRequest, requireAuth, ApiError } from "../../lib/api-client.js";

interface SchemaEnableOptions {
  json?: boolean;
}

export const schemaEnableCommand = new Command("enable")
  .description("Enable a schema (auto-publishes draft and pins the resulting version)")
  .argument("<schema-name>", "Schema name to enable")
  .option("--json", "Output raw JSON")
  .action(async (schemaName: string, _options: SchemaEnableOptions) => {
    requireAuth();
    try {
      const data = await apiRequest("/schema/toggle", {
        method: "POST",
        body: JSON.stringify({ schemaName, enabled: true }),
      });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

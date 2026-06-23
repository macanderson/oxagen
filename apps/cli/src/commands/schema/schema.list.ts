import { Command } from "commander";
import { apiRequest, requireAuth, ApiError } from "../../lib/api-client.js";

interface SchemaListOptions {
  json?: boolean;
}

interface SchemaEntry {
  schemaName: string;
  displayName: string;
  source: string;
  enabled: boolean;
  connectorId?: string | null;
}

interface SchemaListResponse {
  schemas: SchemaEntry[];
}

export const schemaListCommand = new Command("list")
  .description("List all workspace schemas with enabled/disabled state")
  .option("--json", "Output raw JSON")
  .action(async (options: SchemaListOptions) => {
    requireAuth();
    try {
      const data = await apiRequest<SchemaListResponse>("/schema");
      if (options.json) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }
      const schemas = data.schemas;
      if (schemas.length === 0) {
        console.log("No schemas found.");
        return;
      }
      for (const s of schemas) {
        const status = s.enabled ? "enabled" : "disabled";
        console.log(`  ${s.displayName} (${s.schemaName})  [${status}]  source=${s.source}`);
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

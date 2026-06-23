import { Command } from "commander";
import { apiRequest, requireAuth, ApiError } from "../../lib/api-client.js";

interface SchemaGetOptions {
  versionId?: string;
  json?: boolean;
}

export const schemaGetCommand = new Command("get")
  .description("Resolve the workspace schema registry: pinned version, enforcement mode, labels, relationship types")
  .option("--version-id <id>", "Specific version to load (defaults to pinned)")
  .option("--json", "Output raw JSON")
  .action(async (options: SchemaGetOptions) => {
    requireAuth();
    try {
      const params = new URLSearchParams();
      if (options.versionId) params.set("versionId", options.versionId);
      const qs = params.toString() ? `?${params.toString()}` : "";
      const data = await apiRequest(`/schema/registry${qs}`);
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

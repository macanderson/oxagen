import { Command } from "commander";
import { apiRequest, requireAuth, ApiError } from "../../lib/api-client.js";

interface SchemaExportOptions {
  versionId?: string;
  json?: boolean;
}

interface SchemaExportResponse {
  assetId: string;
  serveUrl: string;
  versionId: string;
  versionNumber: number;
}

export const schemaExportCommand = new Command("export")
  .description("Build a ZIP of a schema version and return a download URL")
  .option("--version-id <id>", "Version to export (defaults to pinned version)")
  .option("--json", "Output raw JSON")
  .action(async (options: SchemaExportOptions) => {
    requireAuth();
    try {
      const body: Record<string, unknown> = {};
      if (options.versionId) body.versionId = options.versionId;

      const data = await apiRequest<SchemaExportResponse>("/schema/export", {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (options.json) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log(`Version: ${data.versionNumber} (${data.versionId})`);
        console.log(`Download: ${data.serveUrl}`);
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

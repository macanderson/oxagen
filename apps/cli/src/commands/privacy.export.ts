import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";


interface ExportResponse {
  exportId: string;
  status: string;
  downloadUrl?: string;
}

export const privacyExportCommand = new Command("export")
  .description("Request a GDPR Art.20 data export (ZIP archive)")
  .option("-s, --scope <scope>", "Export scope: user (default) or org", "user")
  .option("--org-id <id>", "Organization ID (required when --scope=org)")
  .action(async (options: { scope: string; orgId?: string }) => {
    if (options.scope !== "user" && options.scope !== "org") {
      console.error("Error: --scope must be 'user' or 'org'");
      process.exit(1);
    }
    if (options.scope === "org" && !options.orgId) {
      console.error("Error: --org-id is required when --scope=org");
      process.exit(1);
    }
    try {
      const data = await apiRequest<ExportResponse>("/privacy/export", {
        method: "POST",
        body: JSON.stringify({
          scope: options.scope,
          ...(options.orgId ? { orgId: options.orgId } : {}),
        }),
      });
      console.log(`Export queued. Export ID: ${data.exportId}`);
      console.log(`Status: ${data.status}`);
      if (process.stdout.isTTY) {
        console.log(`Poll status: oxagen privacy export:status --export-id ${data.exportId}`);
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

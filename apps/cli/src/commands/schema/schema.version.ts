import { Command } from "commander";
import { apiRequest, requireAuth, ApiError } from "../../lib/api-client.js";

interface VersionCreateOptions {
  label?: string;
  changeSummary?: string;
  json?: boolean;
}

interface VersionPinOptions {
  json?: boolean;
}

interface VersionListOptions {
  limit?: string;
  offset?: string;
  json?: boolean;
}

interface VersionDiffOptions {
  json?: boolean;
}

export const schemaVersionCreateCommand = new Command("create")
  .description("Freeze the current draft into an immutable published version and open a fresh draft")
  .option("--label <label>", "Human tag for this version (e.g. Sales CRM v2)")
  .option("--change-summary <text>", "Summary of changes in this version")
  .option("--json", "Output raw JSON")
  .action(async (options: VersionCreateOptions) => {
    requireAuth();
    try {
      const body: Record<string, unknown> = {};
      if (options.label) body.label = options.label;
      if (options.changeSummary) body.changeSummary = options.changeSummary;

      const data = await apiRequest("/schema/versions", {
        method: "POST",
        body: JSON.stringify(body),
      });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

export const schemaVersionPinCommand = new Command("pin")
  .description("Point the workspace at a published version")
  .argument("<version-id>", "The versionId to pin")
  .option("--json", "Output raw JSON")
  .action(async (versionId: string, options: VersionPinOptions) => {
    requireAuth();
    try {
      const data = await apiRequest("/schema/versions/pin", {
        method: "POST",
        body: JSON.stringify({ versionId }),
      });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

export const schemaVersionListCommand = new Command("list")
  .description("List schema versions (number, label, status, published_at, change_summary)")
  .option("--limit <n>", "Max results (default 20)")
  .option("--offset <n>", "Offset for pagination (default 0)")
  .option("--json", "Output raw JSON")
  .action(async (options: VersionListOptions) => {
    requireAuth();
    try {
      const params = new URLSearchParams();
      if (options.limit) params.set("limit", options.limit);
      if (options.offset) params.set("offset", options.offset);
      const qs = params.toString() ? `?${params.toString()}` : "";

      const data = await apiRequest(`/schema/versions${qs}`);
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

export const schemaVersionDiffCommand = new Command("diff")
  .description("Structural diff of two schema versions")
  .argument("<from-version-id>", "Version ID to diff from")
  .argument("<to-version-id>", "Version ID to diff to")
  .option("--json", "Output raw JSON")
  .action(async (fromVersionId: string, toVersionId: string, options: VersionDiffOptions) => {
    requireAuth();
    try {
      const data = await apiRequest("/schema/versions/diff", {
        method: "POST",
        body: JSON.stringify({ fromVersionId, toVersionId }),
      });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

export const schemaVersionCommand = new Command("version")
  .description("Manage schema versions");

schemaVersionCommand.addCommand(schemaVersionCreateCommand);
schemaVersionCommand.addCommand(schemaVersionPinCommand);
schemaVersionCommand.addCommand(schemaVersionListCommand);
schemaVersionCommand.addCommand(schemaVersionDiffCommand);

import { Command } from "commander";
import { apiRequest, requireAuth, ApiError } from "../lib/api-client.js";

interface WorkspaceResponse {
  workspace?: { slug?: string; id?: string; name?: string };
  slug?: string;
  id?: string;
}

export const workspaceCreateCommand = new Command("create")
  .description("Create a new workspace")
  .argument("<name>", "Workspace name")
  .option("--org <slug>", "Organization slug")
  .option("--slug <slug>", "Workspace slug (defaults to slugified name)")
  .action(async (name: string, options: { org?: string; slug?: string }) => {
    requireAuth();
    try {
      const data = await apiRequest<WorkspaceResponse>("/workspaces", {
        method: "POST",
        body: JSON.stringify({ name, org: options.org, slug: options.slug }),
      });
      const ws = data.workspace ?? data;
      console.log(`✓ Workspace created: ${(ws as WorkspaceResponse["workspace"])?.slug ?? (ws as WorkspaceResponse).slug ?? "unknown"}`);
    } catch (err) {
      const _msg = err instanceof ApiError ? err.message : String(err); console.error(`Error: ${_msg}`);
      process.exit(1);
    }
  });

import { Command } from "commander";
import { apiRequest, requireAuth } from "../lib/api-client.js";

interface Workspace {
  id?: string;
  slug?: string;
  name?: string;
}

interface WorkspacesResponse {
  workspaces?: Workspace[];
  data?: Workspace[];
}

export const workspaceListCommand = new Command("list")
  .description("List workspaces in current organization")
  .option("--org <slug>", "Organization slug")
  .action(async (options: { org?: string }) => {
    requireAuth();
    try {
      const qs = options.org ? `?org=${options.org}` : "";
      const data = await apiRequest<WorkspacesResponse>(`/workspaces${qs}`);
      const workspaces = data.workspaces ?? data.data ?? [];
      if (workspaces.length === 0) {
        console.log("No workspaces found.");
        return;
      }
      console.log("Workspaces:");
      for (const ws of workspaces) {
        console.log(`  - ${ws.slug ?? ws.id ?? "unknown"} (${ws.name ?? ""})`);
      }
    } catch (err) {
      console.error(`Error: ${String(err)}`);
      process.exit(1);
    }
  });

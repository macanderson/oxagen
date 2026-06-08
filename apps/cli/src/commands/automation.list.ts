import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";

interface Automation {
  id: string;
  name: string;
  status: string;
  triggers: string[];
}

export const automationListCommand = new Command("list")
  .description("List automations in a workspace")
  .option("-w, --workspace <id>", "Workspace ID (defaults to current workspace)")
  .action(async (options: { workspace?: string }) => {
    try {
      const params = options.workspace ? `?workspace_id=${options.workspace}` : "";
      const data = await apiRequest<Automation[]>(
        `/automation/list${params}`,
        { method: "GET" }
      );
      if (!data.length) {
        console.log("No automations found.");
        return;
      }
      console.log(`✓ ${data.length} automation(s)`);
      for (const a of data) {
        const triggers = a.triggers.length ? a.triggers.join(", ") : "none";
        console.log(`  [${a.status}] ${a.name}  triggers=${triggers}  id=${a.id}`);
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

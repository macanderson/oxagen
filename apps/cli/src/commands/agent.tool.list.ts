import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";

interface Tool {
  id: string;
  name: string;
  description?: string;
}

interface ToolListResponse {
  tools: Tool[];
}

export const agentToolListCommand = new Command("tool:list")
  .description("List available agent tools")
  .option("-w, --workspace <id>", "Workspace ID (defaults to current workspace)")
  .action(async (options: { workspace?: string }) => {
    try {
      const params = new URLSearchParams();
      if (options.workspace) params.append("workspace_id", options.workspace);
      const data = await apiRequest<ToolListResponse>(
        `/agent/tool/list?${params}`,
        { method: "GET" }
      );
      console.log("Agent Tools:");
      data.tools.forEach((t) => {
        console.log(`  ${t.name} (${t.id})`);
        if (t.description) console.log(`    ${t.description}`);
      });
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

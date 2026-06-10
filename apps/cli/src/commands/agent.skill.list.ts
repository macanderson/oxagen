import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";
import { getWorkspaceId } from "../lib/config.js";

interface Skill {
  id: string;
  name: string;
  description?: string;
}

interface SkillListResponse {
  skills: Skill[];
}

export const agentSkillListCommand = new Command("skill:list")
  .description("List available agent skills")
  .option("-w, --workspace <id>", "Workspace ID (defaults to current workspace)")
  .action(async (options: { workspace?: string }) => {
    try {
      const params = new URLSearchParams();
      const workspaceId = options.workspace ?? getWorkspaceId();
      if (workspaceId) params.append("workspace_id", workspaceId);
      const data = await apiRequest<SkillListResponse>(
        `/agent/skill/list?${params}`,
        { method: "GET" }
      );
      console.log("Agent Skills:");
      data.skills.forEach((s) => {
        console.log(`  ${s.name} (${s.id})`);
        if (s.description) console.log(`    ${s.description}`);
      });
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

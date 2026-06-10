import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";
import { getWorkspaceId } from "../lib/config.js";

interface SkillWorkspaceListItem {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
}

interface SkillWorkspaceListResponse {
  skills: SkillWorkspaceListItem[];
}

export const skillWorkspaceListCommand = new Command("list")
  .description("List skills available in the workspace")
  .option("-w, --workspace <id>", "Workspace ID (defaults to current workspace)")
  .action(async (options: { workspace?: string }) => {
    try {
      const params = new URLSearchParams();
      const workspaceId = options.workspace ?? getWorkspaceId();
      if (workspaceId) params.set("workspace_id", workspaceId);
      const query = params.toString() ? `?${params.toString()}` : "";
      const data = await apiRequest<SkillWorkspaceListResponse>(`/skill/workspace/list${query}`);
      if (data.skills.length === 0) {
        console.log("No skills found.");
        return;
      }
      console.log(`Workspace skills (${data.skills.length}):`);
      for (const skill of data.skills) {
        const enabledLabel = skill.enabled ? "enabled" : "disabled";
        console.log(`  ${skill.id}  ${skill.name}  [${enabledLabel}]`);
        if (skill.description) {
          console.log(`    ${skill.description}`);
        }
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";
import { getWorkspaceId } from "../lib/config.js";

interface SkillEnableResponse {
  skill_id: string;
  slug: string;
  enabled: boolean;
}

export const skillEnableCommand = new Command("enable")
  .description("Enable or disable a skill in the workspace")
  .argument("<skill_id>", "Skill public ID (skl_...) or slug")
  .option("--disable", "Disable the skill instead of enabling it")
  .option("-w, --workspace <id>", "Workspace ID (defaults to current workspace)")
  .action(
    async (
      skillId: string,
      options: { disable?: boolean; workspace?: string },
    ) => {
      try {
        const payload: Record<string, unknown> = {
          skill_id: skillId,
          enabled: !options.disable,
        };

        const workspaceId = options.workspace ?? getWorkspaceId();
        if (workspaceId) payload.workspace_id = workspaceId;

        const data = await apiRequest<SkillEnableResponse>("/skill/enable", {
          method: "POST",
          body: JSON.stringify(payload),
        });

        const action = data.enabled ? "enabled" : "disabled";
        console.log(`Skill ${action}: ${data.slug} (${data.skill_id})`);
      } catch (err) {
        const msg = err instanceof ApiError ? err.message : String(err);
        console.error(`Error: ${msg}`);
        process.exit(1);
      }
    },
  );

import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";

interface SkillVersionActivateResponse {
  skillId: string;
  activeVersionNumber: number;
  activatedAt: string;
}

export const skillVersionActivateCommand = new Command("activate")
  .description("Set the active version for a skill (can activate an older version to roll back)")
  .requiredOption("-s, --skill <id>", "Skill public ID (e.g. skl_...)")
  .requiredOption("-v, --version <number>", "Version number to activate", parseInt)
  .action(async (options: { skill: string; version: number }) => {
    try {
      const data = await apiRequest<SkillVersionActivateResponse>("/skill/version/activate", {
        method: "POST",
        body: JSON.stringify({
          skillId: options.skill,
          versionNumber: options.version,
        }),
      });
      console.log(`Skill ${data.skillId} activated version ${data.activeVersionNumber} at ${data.activatedAt}`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { apiRequest, ApiError } from "../lib/api-client.js";

interface SkillEditResponse {
  version_id: string;
  version_number: number;
  skill_id: string;
  activated: boolean;
}

export const skillEditCommand = new Command("edit")
  .description("Save an edited skill body as a new immutable version")
  .requiredOption("-s, --skill <id>", "Skill public ID (e.g. skl_…)")
  .requiredOption("-f, --file <path>", "Path to the updated .skill.md file")
  .option("--no-activate", "Save without setting as the active version (default: activate)")
  .action(async (options: { skill: string; file: string; activate: boolean }) => {
    try {
      const body = await readFile(options.file, "utf8");

      const data = await apiRequest<SkillEditResponse>("/skill/edit", {
        method: "POST",
        body: JSON.stringify({
          skill_id: options.skill,
          body,
          activate: options.activate,
        }),
      });

      console.log(
        `Saved edit to skill ${data.skill_id} → version ${data.version_number} (${data.version_id})${data.activated ? " [active]" : ""}`,
      );
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { apiRequest, ApiError } from "../lib/api-client.js";

interface SkillVersionUploadResponse {
  version_id: string;
  version_number: number;
  skill_id: string;
  activated: boolean;
}

export const skillVersionUploadCommand = new Command("upload")
  .description("Upload a new immutable version of a skill from a .skill.md file")
  .requiredOption("-s, --skill <id>", "Skill public ID (e.g. skl_…)")
  .requiredOption("-f, --file <path>", "Path to the .skill.md file to upload")
  .option("--no-activate", "Upload without setting as the active version (default: activate)")
  .action(async (options: { skill: string; file: string; activate: boolean }) => {
    try {
      const body = await readFile(options.file, "utf8");

      const data = await apiRequest<SkillVersionUploadResponse>("/skill/version/upload", {
        method: "POST",
        body: JSON.stringify({
          skill_id: options.skill,
          body,
          activate: options.activate,
        }),
      });

      console.log(
        `Uploaded skill ${data.skill_id} → version ${data.version_number} (${data.version_id})${data.activated ? " [active]" : ""}`,
      );
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

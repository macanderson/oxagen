import { Command } from "commander";
import { writeFile } from "node:fs/promises";
import { apiRequest, ApiError } from "../lib/api-client.js";

interface SkillExportResponse {
  filename: string;
  content: string;
  versionNumber: number;
}

export const skillExportCommand = new Command("export")
  .description("Export a skill as a .skill.md file")
  .requiredOption("-s, --skill <id>", "Skill public ID (skl_…)")
  .option("-v, --version <number>", "Version number to export (defaults to active version)")
  .option("-o, --output <path>", "Output file path (defaults to <slug>.skill.md in current directory)")
  .action(
    async (options: { skill: string; version?: string; output?: string }) => {
      try {
        const params = new URLSearchParams({ skillId: options.skill });
        if (options.version) params.set("versionNumber", options.version);

        const data = await apiRequest<SkillExportResponse>(
          `/skill/export?${params.toString()}`,
        );

        const outputPath = options.output ?? data.filename;
        await writeFile(outputPath, data.content, "utf8");

        console.log(
          `Exported skill version ${data.versionNumber} → ${outputPath}`,
        );
      } catch (err) {
        const msg = err instanceof ApiError ? err.message : String(err);
        console.error(`Error: ${msg}`);
        process.exit(1);
      }
    },
  );

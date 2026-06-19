import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";

interface SkillVersionGetResponse {
  id: string;
  skill_id: string;
  versionNumber: number;
  isLatest: boolean;
  isActive: boolean;
  body: string;
  frontmatter: Record<string, unknown>;
  referencesPayload: unknown[];
  createdAt: string;
  createdBy: string | null;
}

export const skillVersionGetCommand = new Command("get")
  .description("Fetch a specific version of a skill including full body and frontmatter")
  .requiredOption("-s, --skill <id>", "Skill public ID (e.g. skl_...)")
  .requiredOption("-v, --version-id <id>", "Version public ID (e.g. slv_...)")
  .option("--body", "Print the raw skill body instead of metadata summary")
  .action(async (options: { skill: string; versionId: string; body?: boolean }) => {
    try {
      const params = new URLSearchParams({
        skill_id: options.skill,
        version_id: options.versionId,
      });
      const data = await apiRequest<SkillVersionGetResponse>(
        `/skill/version/get?${params.toString()}`,
      );
      if (options.body) {
        process.stdout.write(data.body);
        return;
      }
      const flags: string[] = [];
      if (data.isActive) flags.push("active");
      if (data.isLatest) flags.push("latest");
      console.log(`Skill:    ${data.skill_id}`);
      console.log(`Version:  ${data.id}  (v${data.versionNumber})  [${flags.join(", ") || "none"}]`);
      console.log(`Created:  ${data.createdAt}${data.createdBy ? ` by ${data.createdBy}` : ""}`);
      if (Object.keys(data.frontmatter).length > 0) {
        console.log("Frontmatter:");
        for (const [k, val] of Object.entries(data.frontmatter)) {
          console.log(`  ${k}: ${JSON.stringify(val)}`);
        }
      }
      if (data.referencesPayload.length > 0) {
        console.log(`References: ${data.referencesPayload.length} item(s)`);
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

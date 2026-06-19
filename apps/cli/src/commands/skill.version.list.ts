import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";

interface SkillVersionItem {
  id: string;
  versionNumber: number;
  isLatest: boolean;
  isActive: boolean;
  createdAt: string;
  createdBy: string | null;
}

interface SkillVersionListResponse {
  skill_id: string;
  versions: SkillVersionItem[];
  total: number;
}

export const skillVersionListCommand = new Command("list")
  .description("List the version history for a skill")
  .requiredOption("-s, --skill <id>", "Skill public ID (e.g. skl_...)")
  .option("-l, --limit <n>", "Maximum versions to return (default 20)", parseInt)
  .option("-o, --offset <n>", "Pagination offset (default 0)", parseInt)
  .action(async (options: { skill: string; limit?: number; offset?: number }) => {
    try {
      const params = new URLSearchParams({ skill_id: options.skill });
      if (options.limit !== undefined) params.set("limit", String(options.limit));
      if (options.offset !== undefined) params.set("offset", String(options.offset));
      const data = await apiRequest<SkillVersionListResponse>(
        `/skill/version/list?${params.toString()}`,
      );
      if (data.versions.length === 0) {
        console.log(`No versions found for skill ${data.skill_id}.`);
        return;
      }
      console.log(`Skill ${data.skill_id} — ${data.total} version(s):`);
      for (const v of data.versions) {
        const flags: string[] = [];
        if (v.isActive) flags.push("active");
        if (v.isLatest) flags.push("latest");
        const flagStr = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
        const by = v.createdBy ? ` by ${v.createdBy}` : "";
        console.log(`  v${v.versionNumber}  ${v.id}${flagStr}  ${v.createdAt}${by}`);
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

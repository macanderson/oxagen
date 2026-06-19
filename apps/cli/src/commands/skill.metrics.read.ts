import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";
import { getWorkspaceId } from "../lib/config.js";

interface PerVersionLoad {
  version: number;
  loads: number;
  lastUsed: string | null;
}

interface SkillMetric {
  skillId: string;
  slug: string;
  activeVersion: number | null;
  usageCount: number;
  lastUsedAt: string | null;
  approxTokenCost: number | null;
  perVersionLoads: PerVersionLoad[];
}

interface SkillMetricsReadResponse {
  skills: SkillMetric[];
}

export const skillMetricsReadCommand = new Command("metrics")
  .description("Read aggregated usage and cost metrics for workspace skills")
  .option("-s, --skill <id>", "Public ID of a specific skill (e.g. skl_…); omit for workspace-wide")
  .option("-w, --workspace <id>", "Workspace ID (defaults to current workspace)")
  .option("--json", "Output raw JSON")
  .action(async (options: { skill?: string; workspace?: string; json?: boolean }) => {
    try {
      const params = new URLSearchParams();
      const workspaceId = options.workspace ?? getWorkspaceId();
      if (workspaceId) params.set("workspace_id", workspaceId);
      if (options.skill) params.set("skill_id", options.skill);
      const query = params.toString() ? `?${params.toString()}` : "";

      const data = await apiRequest<SkillMetricsReadResponse>(`/skill/metrics/read${query}`);

      if (options.json) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }

      if (data.skills.length === 0) {
        console.log("No skills found.");
        return;
      }

      console.log(`Skill metrics (${data.skills.length}):`);
      for (const s of data.skills) {
        const activeLabel = s.activeVersion !== null ? `v${s.activeVersion}` : "no active version";
        const lastUsed = s.lastUsedAt
          ? new Date(s.lastUsedAt).toLocaleString()
          : "never";
        const cost =
          s.approxTokenCost !== null ? `~$${(s.approxTokenCost / 100).toFixed(4)}` : "n/a";

        console.log(`\n  ${s.slug}  (${s.skillId})`);
        console.log(`    Active version : ${activeLabel}`);
        console.log(`    Usage count    : ${s.usageCount}`);
        console.log(`    Last used      : ${lastUsed}`);
        console.log(`    Approx cost    : ${cost}`);

        if (s.perVersionLoads.length > 0) {
          console.log("    Per-version loads:");
          for (const v of s.perVersionLoads) {
            const vLastUsed = v.lastUsed
              ? new Date(v.lastUsed).toLocaleString()
              : "never";
            console.log(`      v${v.version}: ${v.loads} load(s), last used ${vLastUsed}`);
          }
        }
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

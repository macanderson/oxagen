import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";
import { getWorkspaceId } from "../lib/config.js";

interface SkillLoadResponse {
  skillSlug: string;
  loaded: boolean;
  versionLoaded: number;
  body: string;
  capabilities: string[];
  dependencyErrors: Array<{ slug: string; reason: string }>;
}

export const agentSkillLoadCommand = new Command("skill:load")
  .description("Load an agent skill by slug — returns the skill body and referenced capabilities")
  .argument("<slug>", "Skill slug to load")
  .option("-v, --version <constraint>", "Version constraint (e.g. '3', '^2', '~2'). Omit for latest.")
  .option("-d, --deps <slugs...>", "Additional skill slugs to pre-validate as dependencies")
  .option("-w, --workspace <id>", "Workspace ID (defaults to current workspace)")
  .option("--body-only", "Print only the skill body (useful for piping)")
  .action(
    async (
      slug: string,
      options: {
        version?: string;
        deps?: string[];
        workspace?: string;
        bodyOnly?: boolean;
      },
    ) => {
      try {
        const payload: Record<string, unknown> = { skillSlug: slug };
        if (options.version) payload.version = options.version;
        if (options.deps) payload.dependencies = options.deps;

        const workspaceId = options.workspace ?? getWorkspaceId();
        if (workspaceId) payload.workspace_id = workspaceId;

        const data = await apiRequest<SkillLoadResponse>("/agent/skill/load", {
          method: "POST",
          body: JSON.stringify(payload),
        });

        if (!data.loaded) {
          const errors = data.dependencyErrors
            .map((e) => `  - ${e.slug}: ${e.reason}`)
            .join("\n");
          console.error(`Skill "${slug}" could not be loaded.`);
          if (errors) console.error(`Errors:\n${errors}`);
          process.exit(1);
        }

        if (options.bodyOnly) {
          console.log(data.body);
          return;
        }

        console.log(`Skill: ${data.skillSlug} (v${data.versionLoaded})`);
        if (data.capabilities.length > 0) {
          console.log(`Capabilities: ${data.capabilities.join(", ")}`);
        }
        if (data.dependencyErrors.length > 0) {
          console.log("Dependency warnings:");
          data.dependencyErrors.forEach((e) => {
            console.log(`  - ${e.slug}: ${e.reason}`);
          });
        }
        console.log("\n--- Body ---\n");
        console.log(data.body);
      } catch (err) {
        const msg = err instanceof ApiError ? err.message : String(err);
        console.error(`Error: ${msg}`);
        process.exit(1);
      }
    },
  );

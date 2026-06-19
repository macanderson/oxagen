import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";
import { getWorkspaceId } from "../lib/config.js";

interface SkillInstallResponse {
  publicId: string;
  slug: string;
  activeVersion: number;
  installed: boolean;
}

export const skillWorkspaceInstallCommand = new Command("install")
  .description("Install a skill into the workspace from a builtin template or a custom definition")
  .option("-s, --slug <slug>", "Slug of a builtin skill template to install (e.g. 'summarization')")
  .option("-n, --name <name>", "Name for a custom skill (use with --body)")
  .option("-b, --body <body>", "Body/content of a custom skill definition (use with --name)")
  .option("-r, --references <refs...>", "Reference paths for a custom skill")
  .option("-w, --workspace <id>", "Workspace ID (defaults to current workspace)")
  .action(
    async (options: {
      slug?: string;
      name?: string;
      body?: string;
      references?: string[];
      workspace?: string;
    }) => {
      try {
        if (!options.slug && !options.name) {
          console.error(
            "Error: Either --slug (builtin template) or --name + --body (custom) must be provided.",
          );
          process.exit(1);
        }

        const payload: Record<string, unknown> = {};

        if (options.slug) {
          payload.slug = options.slug;
        } else {
          if (!options.body) {
            console.error("Error: --body is required when installing a custom skill.");
            process.exit(1);
          }
          payload.custom = {
            name: options.name,
            body: options.body,
            ...(options.references ? { references: options.references } : {}),
          };
        }

        const workspaceId = options.workspace ?? getWorkspaceId();
        if (workspaceId) payload.workspace_id = workspaceId;

        const data = await apiRequest<SkillInstallResponse>("/skill/workspace/install", {
          method: "POST",
          body: JSON.stringify(payload),
        });

        if (data.installed) {
          console.log(`Skill installed: ${data.slug} (${data.publicId}) v${data.activeVersion}`);
        } else {
          console.log(
            `Skill already installed (idempotent): ${data.slug} (${data.publicId}) v${data.activeVersion}`,
          );
        }
      } catch (err) {
        const msg = err instanceof ApiError ? err.message : String(err);
        console.error(`Error: ${msg}`);
        process.exit(1);
      }
    },
  );

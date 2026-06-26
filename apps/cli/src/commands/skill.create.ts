import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";
import { getWorkspaceId } from "../lib/config.js";
import { readFileSync } from "node:fs";

interface SkillCreateResponse {
  publicId: string;
  slug: string;
  activeVersion: number;
  created: boolean;
}

export const skillCreateCommand = new Command("create")
  .description("Create a new tenant-authored skill in the workspace")
  .requiredOption("-n, --name <name>", "Human-readable name for the skill")
  .requiredOption("-s, --slug <slug>", "Unique kebab-case identifier (e.g. 'code-review')")
  .option("-d, --description <desc>", "Short description of what the skill teaches")
  .option("-b, --body <body>", "Skill body content (YAML frontmatter + markdown)")
  .option("-f, --file <path>", "Read skill body from a .skill.md file")
  .option("--no-activate", "Do not activate the initial version")
  .option("-w, --workspace <id>", "Workspace ID (defaults to current workspace)")
  .action(
    async (options: {
      name: string;
      slug: string;
      description?: string;
      body?: string;
      file?: string;
      activate: boolean;
      workspace?: string;
    }) => {
      try {
        let body = options.body;
        if (options.file) {
          body = readFileSync(options.file, "utf-8");
        }
        if (!body) {
          console.error("Error: Either --body or --file must be provided.");
          process.exit(1);
        }

        const payload: Record<string, unknown> = {
          name: options.name,
          slug: options.slug,
          body,
          activate: options.activate,
        };
        if (options.description) payload.description = options.description;

        const workspaceId = options.workspace ?? getWorkspaceId();
        if (workspaceId) payload.workspace_id = workspaceId;

        const data = await apiRequest<SkillCreateResponse>("/skill/create", {
          method: "POST",
          body: JSON.stringify(payload),
        });

        if (data.created) {
          console.log(
            `Skill created: ${data.slug} (${data.publicId}) v${data.activeVersion}`,
          );
        } else {
          console.log(
            `Skill already exists (idempotent): ${data.slug} (${data.publicId}) v${data.activeVersion}`,
          );
        }
      } catch (err) {
        const msg = err instanceof ApiError ? err.message : String(err);
        console.error(`Error: ${msg}`);
        process.exit(1);
      }
    },
  );

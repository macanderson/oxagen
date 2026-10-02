/**
 * `oxagen tools migrate`: move the workspace's connected MCP servers into its
 * steering repo, the CLI side of `migrate_tools_to_steering` (ADR-245,
 * #4948).
 *
 * POSTs `/v1/{org}/{ws}/tools/steering/migrate` with `{}`. The call is safe
 * to repeat: a second run prints the pull request the first one opened, or
 * that the workspace has already migrated. Org Owners and Admins only.
 *
 * Output discipline (ADR-023 §4): `--json` prints the contract output as one
 * line on stdout. The default view names the state and each pull request. An
 * API failure is one stderr line and exit 1.
 */
import { apiPostOrThrow } from "../lib/api.js";
import { createOutput } from "../lib/output.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";

// Local mirror of the migrate_tools_to_steering contract output. The CLI talks
// to the API over HTTP and does not depend on @oxagen/oxagen, so the shape is
// declared here (kept in step with
// packages/oxagen/src/contracts/tool.steering.migrate.ts).
export interface ToolMigrationPullRequest {
  number: number;
  url: string;
}

export interface ToolMigrationOutput {
  state: "opened" | "already_open" | "already_migrated";
  pullRequest: ToolMigrationPullRequest | null;
  pullRequests: ToolMigrationPullRequest[];
}

export interface ToolsMigrateOptions {
  json?: boolean;
}

const HEADLINES: Record<ToolMigrationOutput["state"], string> = {
  opened:
    "Opened the migration pull request. When it merges, the next publish moves each server into the steering repo.",
  already_open:
    "The migration pull request is already open. Review and merge it to move the servers.",
  already_migrated: "This workspace's MCP servers already live in its steering repo.",
};

export async function toolsMigrate(
  opts: ToolsMigrateOptions = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const cmd = createOutput({ json: opts.json }, writer);
  let result: ToolMigrationOutput;
  try {
    result = await apiPostOrThrow<ToolMigrationOutput>("tools/steering/migrate", {});
  } catch (err) {
    cmd.error(err, "api");
    return;
  }
  if (cmd.isJson) {
    cmd.data(result);
    return;
  }
  writer.write(HEADLINES[result.state]);
  for (const pr of result.pullRequests) writer.write(`#${pr.number}  ${pr.url}`);
}

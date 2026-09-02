import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentRepoEdit } from "@oxagen/oxagen/contracts/agent.repo.edit";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentRepoEdit.input.shape,
  owner: agentRepoEdit.input.shape.owner.describe(
    "GitHub organisation or user that owns the repository",
  ),
  repo: agentRepoEdit.input.shape.repo.describe(
    "Repository name (without the owner prefix)",
  ),
  instruction: agentRepoEdit.input.shape.instruction.describe(
    "Natural-language coding instruction for the agent (min 10 chars)",
  ),
  baseBranch: agentRepoEdit.input.shape.baseBranch.describe(
    "Branch to base the changes on (defaults to 'main' when omitted)",
  ),
  branchName: agentRepoEdit.input.shape.branchName.describe(
    "Branch name to push the agent's changes to (auto-generated when omitted)",
  ),
  model: agentRepoEdit.input.shape.model.describe(
    "Vercel AI Gateway model id, e.g. 'anthropic/claude-opus-4-8'",
  ),
  maxSteps: agentRepoEdit.input.shape.maxSteps.describe(
    "Maximum coding-loop steps the agent may execute (1-40, default 12)",
  ),
};

export const metadata: ToolMetadata = {
  name: agentRepoEdit.name,
  description:
    "Runs the coding agent end-to-end on a connected GitHub repository: edits files per a natural-language instruction, commits to a branch, and opens the pull request in one call. Prefer this over put_repo_file + open_pr when the agent should decide which files to change; use put_repo_file/create_branch/open_pr directly when the exact file contents are already known and only mechanical commit/PR steps are needed. Do not use for read-only code inspection.",
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function agentRepoEditTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentRepoEdit.name, args, ctx, {
    surface: "mcp",
  });
  return agentRepoEdit.output.parse(output);
}

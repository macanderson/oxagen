import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { repoBranchCreate } from "@oxagen/oxagen/contracts/repo.branch.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...repoBranchCreate.input.shape,
  owner: repoBranchCreate.input.shape.owner.describe(
    "Repository owner (user or organisation)",
  ),
  repo: repoBranchCreate.input.shape.repo.describe("Repository name"),
  branch: repoBranchCreate.input.shape.branch.describe(
    "Name of the new branch to create",
  ),
  fromBranch: repoBranchCreate.input.shape.fromBranch.describe(
    "Branch to base the new branch on (defaults to the repository default branch)",
  ),
};

export const metadata: ToolMetadata = {
  name: repoBranchCreate.name,
  description:
    "Creates a new branch in a GitHub repository from an existing branch (or the repository default branch). Prefer over edit_repo_file's auto-generated branch naming when a specific, pre-determined branch name is required before making commits. Do not use to open a pull request — use open_pr once commits land on the branch.",
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function repoBranchCreateTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(repoBranchCreate.name, args, ctx, {
    surface: "mcp",
  });
  return repoBranchCreate.output.parse(output);
}

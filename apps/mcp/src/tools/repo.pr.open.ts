import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { repoPrOpen } from "@oxagen/oxagen/contracts/repo.pr.open";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...repoPrOpen.input.shape,
  owner: repoPrOpen.input.shape.owner.describe(
    "Repository owner (user or organisation)",
  ),
  repo: repoPrOpen.input.shape.repo.describe("Repository name"),
  title: repoPrOpen.input.shape.title.describe("Pull request title"),
  head: repoPrOpen.input.shape.head.describe(
    "Branch containing the changes (e.g. feature/my-branch)",
  ),
  base: repoPrOpen.input.shape.base.describe(
    "Branch the PR is targeting (e.g. main)",
  ),
  body: repoPrOpen.input.shape.body.describe(
    "Pull request description body (Markdown)",
  ),
  draft: repoPrOpen.input.shape.draft.describe("Open as a draft pull request"),
};

export const metadata: ToolMetadata = {
  name: repoPrOpen.name,
  description:
    "Opens a pull request between two branches in a GitHub repository. Prefer over edit_repo_file when the branch and commits already exist and only the PR needs to be opened. Do not use to make code changes — commit first via put_repo_file or edit_repo_file.",
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function repoPrOpenTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(repoPrOpen.name, args, ctx, { surface: "mcp" });
  return repoPrOpen.output.parse(output);
}

import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { repoBranchList } from "@oxagen/oxagen/contracts/repo.branch.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...repoBranchList.input.shape,
  owner: repoBranchList.input.shape.owner.describe(
    "Repository owner (user or organisation)",
  ),
  repo: repoBranchList.input.shape.repo.describe("Repository name"),
};

export const metadata: ToolMetadata = {
  name: repoBranchList.name,
  description:
    "Lists branches in a GitHub repository, including each branch's current SHA, protection status, and which one is the repository's default branch.",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function repoBranchListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(repoBranchList.name, args, ctx, {
    surface: "mcp",
  });
  return repoBranchList.output.parse(output);
}

import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { repositoryProductionBranchSet } from "@oxagen/oxagen/contracts/repository.production_branch.set";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  bindingId: repositoryProductionBranchSet.input.shape.bindingId.describe(
    "The repository's binding id (rpb_…) from list_repositories",
  ),
  branch: repositoryProductionBranchSet.input.shape.branch.describe(
    "The branch to make the production branch; it must exist on GitHub",
  ),
};

export const metadata: ToolMetadata = {
  name: repositoryProductionBranchSet.name,
  description: repositoryProductionBranchSet.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function repositoryProductionBranchSetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(repositoryProductionBranchSet.name, args, ctx, {
    surface: "mcp",
  });
  return repositoryProductionBranchSet.output.parse(output);
}

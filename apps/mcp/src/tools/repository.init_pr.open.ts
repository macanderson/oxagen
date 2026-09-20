import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { repositoryInitPrOpen } from "@oxagen/oxagen/contracts/repository.init_pr.open";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  bindingId: repositoryInitPrOpen.input.shape.bindingId.describe(
    "The repository's binding id (rpb_…) from list_repositories",
  ),
  governanceMode: repositoryInitPrOpen.input.shape.governanceMode.describe(
    "solo, team or regulated; governanceToml must declare the same mode",
  ),
  workspaceToml: repositoryInitPrOpen.input.shape.workspaceToml.describe(
    "The .oxagen/workspace.toml to propose, as TOML text",
  ),
  governanceToml: repositoryInitPrOpen.input.shape.governanceToml.describe(
    "The .oxagen/rules/governance.toml to propose, as TOML text",
  ),
};

export const metadata: ToolMetadata = {
  name: repositoryInitPrOpen.name,
  description: repositoryInitPrOpen.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function repositoryInitPrOpenTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(repositoryInitPrOpen.name, args, ctx, {
    surface: "mcp",
  });
  return repositoryInitPrOpen.output.parse(output);
}

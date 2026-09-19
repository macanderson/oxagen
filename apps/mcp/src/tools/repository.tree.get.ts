import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { repositoryTreeGet } from "@oxagen/oxagen/contracts/repository.tree.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  bindingId: repositoryTreeGet.input.shape.bindingId.describe(
    "The repository's binding id (rpb_…) from list_repositories",
  ),
};

export const metadata: ToolMetadata = {
  name: repositoryTreeGet.name,
  description: repositoryTreeGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function repositoryTreeGetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(repositoryTreeGet.name, args, ctx, {
    surface: "mcp",
  });
  return repositoryTreeGet.output.parse(output);
}

import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { repositoryUnlink } from "@oxagen/oxagen/contracts/repository.unlink";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  bindingId: repositoryUnlink.input.shape.bindingId.describe(
    "The linked repository's binding id (rpb_…) from list_repositories; the main repository is refused",
  ),
};

export const metadata: ToolMetadata = {
  name: repositoryUnlink.name,
  description: repositoryUnlink.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function repositoryUnlinkTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(repositoryUnlink.name, args, ctx, {
    surface: "mcp",
  });
  return repositoryUnlink.output.parse(output);
}

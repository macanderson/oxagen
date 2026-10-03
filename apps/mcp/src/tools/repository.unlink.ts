import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { repositoryUnlink } from "@oxagen/oxagen/contracts/repository.unlink";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { toolResult } from "../tool-result";

export const schema = {
  bindingId: repositoryUnlink.input.shape.bindingId.describe(
    "The linked repository's binding id (rpb_…) from list_repositories. The steering repository is refused",
  ),
};

export const metadata: ToolMetadata = {
  name: repositoryUnlink.name,
  description: repositoryUnlink.description,
  // Destructive: the handler deletes the repository's head and drops it
  // from the workspace, so a client that confirms destructive tools asks a
  // person first (#3340 finding 5).
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
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
  return toolResult(repositoryUnlink.output.parse(output));
}

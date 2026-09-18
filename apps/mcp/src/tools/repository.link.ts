import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { repositoryLink } from "@oxagen/oxagen/contracts/repository.link";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...repositoryLink.input.shape,
  owner: repositoryLink.input.shape.owner.describe(
    "The repository's owner account on GitHub",
  ),
  name: repositoryLink.input.shape.name.describe("The repository's name"),
};

export const metadata: ToolMetadata = {
  name: repositoryLink.name,
  description: repositoryLink.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function repositoryLinkTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(repositoryLink.name, args, ctx, {
    surface: "mcp",
  });
  return repositoryLink.output.parse(output);
}

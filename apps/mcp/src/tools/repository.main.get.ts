import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { repositoryMainGet } from "@oxagen/oxagen/contracts/repository.main.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...repositoryMainGet.input.shape,
};

export const metadata: ToolMetadata = {
  name: repositoryMainGet.name,
  description: repositoryMainGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function repositoryMainGetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(repositoryMainGet.name, args, ctx, {
    surface: "mcp",
  });
  return repositoryMainGet.output.parse(output);
}

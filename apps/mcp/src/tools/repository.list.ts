import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { repositoryList } from "@oxagen/oxagen/contracts/repository.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...repositoryList.input.shape,
};

export const metadata: ToolMetadata = {
  name: repositoryList.name,
  description: repositoryList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function repositoryListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(repositoryList.name, args, ctx, {
    surface: "mcp",
  });
  return repositoryList.output.parse(output);
}

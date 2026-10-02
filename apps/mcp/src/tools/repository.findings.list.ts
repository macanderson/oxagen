import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { codeRepositoryFindingsList } from "@oxagen/oxagen/contracts/repository.findings.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...codeRepositoryFindingsList.input.shape };

export const metadata: ToolMetadata = {
  name: codeRepositoryFindingsList.name,
  description: codeRepositoryFindingsList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function listCodeRepositoryFindingsTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(codeRepositoryFindingsList.name, args, ctx, {
    surface: "mcp",
  });
  return codeRepositoryFindingsList.output.parse(output);
}

import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { repositoryInstallationList } from "@oxagen/oxagen/contracts/repository.installation.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { toolResult } from "../tool-result";

export const schema = {
  ...repositoryInstallationList.input.shape,
};

export const metadata: ToolMetadata = {
  name: repositoryInstallationList.name,
  description: repositoryInstallationList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function repositoryInstallationListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(repositoryInstallationList.name, args, ctx, {
    surface: "mcp",
  });
  return toolResult(repositoryInstallationList.output.parse(output));
}

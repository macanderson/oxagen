import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { repositoryInstallationCandidates } from "@oxagen/oxagen/contracts/repository.installation.candidates";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...repositoryInstallationCandidates.input.shape,
};

export const metadata: ToolMetadata = {
  name: repositoryInstallationCandidates.name,
  description: repositoryInstallationCandidates.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function repositoryInstallationCandidatesTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(
    repositoryInstallationCandidates.name,
    args,
    ctx,
    { surface: "mcp" },
  );
  return repositoryInstallationCandidates.output.parse(output);
}

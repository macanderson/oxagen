import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { steeringRepoImport } from "@oxagen/oxagen/contracts/steering_repo.import";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = steeringRepoImport.input.shape;

// The import opens PRs and changes no default branch. A second call answers
// the finished run or resumes a stopped one, so it opens no PR twice.
export const metadata: ToolMetadata = {
  name: steeringRepoImport.name,
  description: steeringRepoImport.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function importWorkspaceSteeringTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(steeringRepoImport.name, args, ctx, {
    surface: "mcp",
  });
  return steeringRepoImport.output.parse(output);
}

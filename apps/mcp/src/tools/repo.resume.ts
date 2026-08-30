import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { repoResume } from "@oxagen/oxagen/contracts/repo.resume";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...repoResume.input.shape,
  repoId: repoResume.input.shape.repoId.describe(
    "Repository connection ID to resume",
  ),
};

export const metadata: ToolMetadata = {
  name: repoResume.name,
  description: repoResume.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function repoResumeTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(repoResume.name, args, ctx, { surface: "mcp" });
  return repoResume.output.parse(output);
}

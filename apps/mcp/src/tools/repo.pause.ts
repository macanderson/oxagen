import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { repoPause } from "@oxagen/oxagen/contracts/repo.pause";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...repoPause.input.shape,
  repoId: repoPause.input.shape.repoId.describe(
    "Repository connection ID to pause",
  ),
};

export const metadata: ToolMetadata = {
  name: repoPause.name,
  description: repoPause.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function repoPauseTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(repoPause.name, args, ctx, { surface: "mcp" });
  return repoPause.output.parse(output);
}

import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { steeringPrRestoreManagedBlock } from "@oxagen/oxagen/contracts/steering.pr.restore_managed_block";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...steeringPrRestoreManagedBlock.input.shape };

// It adds one commit to the steering PR's branch and changes no production
// branch. The branch history keeps the PR's own edits, so nothing is lost. A
// second call finds the block intact and writes nothing.
export const metadata: ToolMetadata = {
  name: steeringPrRestoreManagedBlock.name,
  description: steeringPrRestoreManagedBlock.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function restoreManagedBlockTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(steeringPrRestoreManagedBlock.name, args, ctx, {
    surface: "mcp",
  });
  return steeringPrRestoreManagedBlock.output.parse(output);
}

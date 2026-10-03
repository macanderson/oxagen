import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { steeringPrRevert } from "@oxagen/oxagen/contracts/steering.pr.revert";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { toolResult } from "../tool-result";

export const schema = {
  proposalId: steeringPrRevert.input.shape.proposalId.describe(
    "The merged proposal (prp_…) whose steering PR the revert undoes",
  ),
};

export const metadata: ToolMetadata = {
  name: steeringPrRevert.name,
  description: steeringPrRevert.description,
  annotations: {
    readOnlyHint: false,
    // It opens a pull request and merges nothing. The production branch
    // changes only when that pull request merges after its own review.
    destructiveHint: false,
    // A second call is refused while the first revert's branch exists.
    idempotentHint: false,
  },
};

export default async function steeringPrRevertTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(steeringPrRevert.name, args, ctx, {
    surface: "mcp",
  });
  return toolResult(steeringPrRevert.output.parse(output));
}

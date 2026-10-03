import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { steeringProposalCreate } from "@oxagen/oxagen/contracts/steering.proposal.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { toolResult } from "../tool-result";

export const schema = { ...steeringProposalCreate.input.shape };

export const metadata: ToolMetadata = {
  name: steeringProposalCreate.name,
  description: steeringProposalCreate.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function steeringProposalCreateTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(steeringProposalCreate.name, args, ctx, {
    surface: "mcp",
  });
  return toolResult(steeringProposalCreate.output.parse(output));
}

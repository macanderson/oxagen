import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { steeringProposalList } from "@oxagen/oxagen/contracts/steering.proposal.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...steeringProposalList.input.shape };

export const metadata: ToolMetadata = {
  name: steeringProposalList.name,
  description: steeringProposalList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function steeringProposalListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(steeringProposalList.name, args, ctx, {
    surface: "mcp",
  });
  return steeringProposalList.output.parse(output);
}

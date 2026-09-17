import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { contextProposalCreate } from "@oxagen/oxagen/contracts/context.proposal.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...contextProposalCreate.input.shape };

export const metadata: ToolMetadata = {
  name: contextProposalCreate.name,
  description: contextProposalCreate.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function contextProposalCreateTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(contextProposalCreate.name, args, ctx, {
    surface: "mcp",
  });
  return contextProposalCreate.output.parse(output);
}

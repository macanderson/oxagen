import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { contextProposalList } from "@oxagen/oxagen/contracts/context.proposal.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...contextProposalList.input.shape };

export const metadata: ToolMetadata = {
  name: contextProposalList.name,
  description: contextProposalList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function contextProposalListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(contextProposalList.name, args, ctx, {
    surface: "mcp",
  });
  return contextProposalList.output.parse(output);
}

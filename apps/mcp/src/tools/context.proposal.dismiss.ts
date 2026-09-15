import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { contextProposalDismiss } from "@oxagen/oxagen/contracts/context.proposal.dismiss";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...contextProposalDismiss.input.shape };

export const metadata: ToolMetadata = {
  name: contextProposalDismiss.name,
  description: contextProposalDismiss.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function contextProposalDismissTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(contextProposalDismiss.name, args, ctx, {
    surface: "mcp",
  });
  return contextProposalDismiss.output.parse(output);
}

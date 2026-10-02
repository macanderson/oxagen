import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { contextPrRevert } from "@oxagen/oxagen/contracts/context.pr.revert";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  proposalId: contextPrRevert.input.shape.proposalId.describe(
    "The merged proposal (prp_…) whose steering PR the revert undoes",
  ),
};

export const metadata: ToolMetadata = {
  name: contextPrRevert.name,
  description: contextPrRevert.description,
  annotations: {
    readOnlyHint: false,
    // It opens a pull request and merges nothing. The production branch
    // changes only when that pull request merges after its own review.
    destructiveHint: false,
    // A second call is refused while the first revert's branch exists.
    idempotentHint: false,
  },
};

export default async function contextPrRevertTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(contextPrRevert.name, args, ctx, {
    surface: "mcp",
  });
  return contextPrRevert.output.parse(output);
}

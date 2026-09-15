import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { findingDismiss } from "@oxagen/oxagen/contracts/finding.dismiss";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  findingId: findingDismiss.input.shape.findingId.describe(
    "The finding's public id (fnd_…), as list_findings reports it",
  ),
};

export const metadata: ToolMetadata = {
  name: findingDismiss.name,
  description: findingDismiss.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function findingDismissTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const input = findingDismiss.input.parse(args);
  const output = await invoke(findingDismiss.name, input, ctx, {
    surface: "mcp",
  });
  return findingDismiss.output.parse(output);
}

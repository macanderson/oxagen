import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { findingFixRecord } from "@oxagen/oxagen/contracts/finding.fix.record";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  findingId: findingFixRecord.input.shape.findingId.describe(
    "The finding's public id (fnd_…), as list_findings reports it",
  ),
};

export const metadata: ToolMetadata = {
  name: findingFixRecord.name,
  description: findingFixRecord.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function findingFixRecordTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const input = findingFixRecord.input.parse(args);
  const output = await invoke(findingFixRecord.name, input, ctx, {
    surface: "mcp",
  });
  return findingFixRecord.output.parse(output);
}

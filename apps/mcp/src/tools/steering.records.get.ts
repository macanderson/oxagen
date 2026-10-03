import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { steeringRecordsGet } from "@oxagen/oxagen/contracts/steering.records.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { toolResult } from "../tool-result";

export const schema = { ...steeringRecordsGet.input.shape };

export const metadata: ToolMetadata = {
  name: steeringRecordsGet.name,
  description: steeringRecordsGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function steeringRecordsGetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(steeringRecordsGet.name, args, ctx, {
    surface: "mcp",
  });
  return toolResult(steeringRecordsGet.output.parse(output));
}

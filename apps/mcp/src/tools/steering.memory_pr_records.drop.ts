import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { steeringMemoryPrRecordDrop } from "@oxagen/oxagen/contracts/steering.memory_pr_records.drop";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...steeringMemoryPrRecordDrop.input.shape };

export const metadata: ToolMetadata = {
  name: steeringMemoryPrRecordDrop.name,
  description: steeringMemoryPrRecordDrop.description,
  annotations: {
    readOnlyHint: false,
    // The commit deletes the record's file from the PR's branch. The record
    // was never published, and the memories it cites wait again.
    destructiveHint: true,
    // A second drop of the same path answers the first drop's commit.
    idempotentHint: true,
  },
};

export default async function dropMemoryRecordTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(steeringMemoryPrRecordDrop.name, args, ctx, {
    surface: "mcp",
  });
  return steeringMemoryPrRecordDrop.output.parse(output);
}

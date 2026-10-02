import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { workCollectorSet } from "@oxagen/oxagen/contracts/work.collector.set";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...workCollectorSet.input.shape };

export const metadata: ToolMetadata = {
  name: workCollectorSet.name,
  description: workCollectorSet.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function setWorkCollectorTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(workCollectorSet.name, args, ctx, {
    surface: "mcp",
  });
  return workCollectorSet.output.parse(output);
}

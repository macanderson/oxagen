import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { workCollectorSync } from "@oxagen/oxagen/contracts/work.collector.sync";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...workCollectorSync.input.shape };

export const metadata: ToolMetadata = {
  name: workCollectorSync.name,
  description: workCollectorSync.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function syncWorkCollectorTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(workCollectorSync.name, args, ctx, {
    surface: "mcp",
  });
  return workCollectorSync.output.parse(output);
}

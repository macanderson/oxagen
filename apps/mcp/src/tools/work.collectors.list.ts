import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { workCollectorsList } from "@oxagen/oxagen/contracts/work.collectors.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...workCollectorsList.input.shape };

export const metadata: ToolMetadata = {
  name: workCollectorsList.name,
  description: workCollectorsList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function listWorkCollectorsTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(workCollectorsList.name, args, ctx, {
    surface: "mcp",
  });
  return workCollectorsList.output.parse(output);
}

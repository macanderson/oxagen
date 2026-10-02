import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { workItemCreate } from "@oxagen/oxagen/contracts/work.item.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...workItemCreate.input.shape };

export const metadata: ToolMetadata = {
  name: workItemCreate.name,
  description: workItemCreate.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function createWorkItemTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(workItemCreate.name, args, ctx, {
    surface: "mcp",
  });
  return workItemCreate.output.parse(output);
}

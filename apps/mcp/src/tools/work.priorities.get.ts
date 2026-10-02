import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { workPrioritiesGet } from "@oxagen/oxagen/contracts/work.priorities.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...workPrioritiesGet.input.shape };

export const metadata: ToolMetadata = {
  name: workPrioritiesGet.name,
  description: workPrioritiesGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function getWorkPrioritiesTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(workPrioritiesGet.name, args, ctx, {
    surface: "mcp",
  });
  return workPrioritiesGet.output.parse(output);
}

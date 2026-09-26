import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentList } from "@oxagen/oxagen/contracts/agent.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentList.input.shape,
  limit: agentList.input.shape.limit.describe(
    "Page size, 1 to 100; default 50",
  ),
  cursor: agentList.input.shape.cursor.describe(
    "The nextCursor of the previous page",
  ),
  includeRetired: agentList.input.shape.includeRetired.describe(
    "List retired (deregistered) agents too; default false. A retired agent takes no new work",
  ),
};

export const metadata: ToolMetadata = {
  name: agentList.name,
  description: agentList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function agentListTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentList.name, args, ctx, { surface: "mcp" });
  return agentList.output.parse(output);
}

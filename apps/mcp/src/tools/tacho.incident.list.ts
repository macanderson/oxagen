import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { tachoIncidentList } from "@oxagen/oxagen/contracts/tacho.incident.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...tachoIncidentList.input.shape,
  agentId: tachoIncidentList.input.shape.agentId.describe(
    "Only incidents on hosts enrolled under this agent (agt_… or slug)",
  ),
  open: tachoIncidentList.input.shape.open.describe(
    "Only unresolved incidents",
  ),
  limit: tachoIncidentList.input.shape.limit.describe(
    "Page size, 1 to 100; default 50",
  ),
  cursor: tachoIncidentList.input.shape.cursor.describe(
    "The nextCursor of the previous page",
  ),
};

export const metadata: ToolMetadata = {
  name: tachoIncidentList.name,
  description: tachoIncidentList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function tachoIncidentListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(tachoIncidentList.name, args, ctx, {
    surface: "mcp",
  });
  return tachoIncidentList.output.parse(output);
}

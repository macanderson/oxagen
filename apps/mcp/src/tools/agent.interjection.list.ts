import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentInterjectionList } from "@oxagen/oxagen/contracts/agent.interjection.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentInterjectionList.input.shape,
  runId: agentInterjectionList.input.shape.runId.describe(
    "Only questions raised in this run (a run public id)",
  ),
  open: agentInterjectionList.input.shape.open.describe(
    "True lists only unanswered questions whose run still waits; false lists every question. Default true",
  ),
  limit: agentInterjectionList.input.shape.limit.describe(
    "Page size, 1 to 100; default 50",
  ),
  cursor: agentInterjectionList.input.shape.cursor.describe(
    "The nextCursor of the previous page",
  ),
};

export const metadata: ToolMetadata = {
  name: agentInterjectionList.name,
  description: agentInterjectionList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function agentInterjectionListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentInterjectionList.name, args, ctx, {
    surface: "mcp",
  });
  return agentInterjectionList.output.parse(output);
}

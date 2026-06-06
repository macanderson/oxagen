import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { conversationList } from "@oxagen/oxagen/contracts/conversation.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...conversationList.input.shape,
  filter: conversationList.input.shape.filter.describe(
    'Which conversations to return: "active" (not archived) or "archived". Defaults to "active".',
  ),
  limit: conversationList.input.shape.limit.describe(
    "Maximum number of conversations to return (1–100). Defaults to 50.",
  ),
  cursor: conversationList.input.shape.cursor.describe(
    "Keyset pagination cursor (ISO updated_at of the last row from the previous page). Null starts at the newest row.",
  ),
};

export const metadata: ToolMetadata = {
  name: conversationList.name,
  description: conversationList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function conversationListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(conversationList.name, args, ctx, {
    surface: "mcp",
  });
  return conversationList.output.parse(output);
}

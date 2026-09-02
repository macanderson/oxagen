import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { notificationsList } from "@oxagen/oxagen/contracts/notification.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...notificationsList.input.shape,
};

export const metadata: ToolMetadata = {
  name: notificationsList.name,
  description: notificationsList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function notificationsListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(notificationsList.name, args, ctx, {
    surface: "mcp",
  });
  return notificationsList.output.parse(output);
}

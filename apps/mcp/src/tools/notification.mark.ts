import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { notificationsMark } from "@oxagen/oxagen/contracts/notification.mark";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...notificationsMark.input.shape,
};

export const metadata: ToolMetadata = {
  name: notificationsMark.name,
  description: notificationsMark.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function notificationsMarkTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(notificationsMark.name, args, ctx, {
    surface: "mcp",
  });
  return notificationsMark.output.parse(output);
}

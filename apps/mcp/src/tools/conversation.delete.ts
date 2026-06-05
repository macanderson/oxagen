import { z } from "zod";
import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { conversationDelete } from "@oxagen/oxagen/contracts/conversation.delete";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  conversationIds: z
    .array(z.string().min(1))
    .min(1)
    .max(100)
    .describe(
      "List of cnv_ public ids to permanently delete (1–100 items). This action is irreversible from the product surface; rows are retained for audit via soft-delete.",
    ),
};

export const metadata: ToolMetadata = {
  name: conversationDelete.name,
  description: conversationDelete.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
  },
};

export default async function conversationDeleteTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(conversationDelete.name, args, ctx, {
    surface: "mcp",
  });
  return conversationDelete.output.parse(output);
}

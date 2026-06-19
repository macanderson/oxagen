import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { conversationFilesList } from "@oxagen/oxagen/contracts/conversation.files.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  conversationId: conversationFilesList.input.shape.conversationId.describe(
    "The public ID of the conversation whose generated files to list.",
  ),
  kind: conversationFilesList.input.shape.kind.describe(
    'Optional kind filter: "image" | "video" | "document" | "spreadsheet" | "presentation" | "pdf" | "archive". Omit to return all kinds.',
  ),
  limit: conversationFilesList.input.shape.limit.describe(
    "Maximum number of files to return (1–200). Defaults to 50.",
  ),
  cursor: conversationFilesList.input.shape.cursor.describe(
    "Keyset pagination cursor (ISO createdAt of the last row from the previous page). Null starts at the newest file.",
  ),
};

export const metadata: ToolMetadata = {
  name: conversationFilesList.name,
  description: conversationFilesList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function conversationFilesListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(conversationFilesList.name, args, ctx, {
    surface: "mcp",
  });
  return conversationFilesList.output.parse(output);
}

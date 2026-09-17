import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { credentialGrantList } from "@oxagen/oxagen/contracts/credential.grant.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...credentialGrantList.input.shape,
  connectionId: credentialGrantList.input.shape.connectionId.describe(
    "Only grants drawn on this mcrd_… connection",
  ),
  limit: credentialGrantList.input.shape.limit.describe(
    "Max grants to return (1–100)",
  ),
  cursor: credentialGrantList.input.shape.cursor.describe(
    "The nextCursor of an earlier page; omit for the first page",
  ),
};

export const metadata: ToolMetadata = {
  name: credentialGrantList.name,
  description: credentialGrantList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function credentialGrantListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(credentialGrantList.name, args, ctx, {
    surface: "mcp",
  });
  return credentialGrantList.output.parse(output);
}

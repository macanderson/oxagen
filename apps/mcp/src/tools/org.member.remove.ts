import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { orgMemberRemove } from "@oxagen/oxagen/contracts/org.member.remove";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...orgMemberRemove.input.shape,
  targetUserId: orgMemberRemove.input.shape.targetUserId.describe(
    "UUID of the user to remove from the org",
  ),
};

export const metadata: ToolMetadata = {
  name: orgMemberRemove.name,
  description: orgMemberRemove.description,
  annotations: {
    readOnlyHint: false,
    // Destructive: permanently removes a member and deletes their principal.
    destructiveHint: true,
    idempotentHint: false,
  },
};

export default async function orgMemberRemoveTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(orgMemberRemove.name, args, ctx, {
    surface: "mcp",
  });
  return orgMemberRemove.output.parse(output);
}

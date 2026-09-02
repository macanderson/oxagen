import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { orgMemberRoleChange } from "@oxagen/oxagen/contracts/org.member_role.change";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...orgMemberRoleChange.input.shape,
  targetUserId: orgMemberRoleChange.input.shape.targetUserId.describe(
    "UUID of the user whose role to change",
  ),
  newRole: orgMemberRoleChange.input.shape.newRole.describe(
    "New org role name — one of: Owner, Admin, Member, Billing, Compliance",
  ),
};

export const metadata: ToolMetadata = {
  name: orgMemberRoleChange.name,
  description: orgMemberRoleChange.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function orgMemberRoleChangeTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(orgMemberRoleChange.name, args, ctx, {
    surface: "mcp",
  });
  return orgMemberRoleChange.output.parse(output);
}

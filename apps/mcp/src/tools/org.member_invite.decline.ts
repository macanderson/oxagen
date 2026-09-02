import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { orgMemberInviteDecline } from "@oxagen/oxagen/contracts/org.member_invite.decline";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...orgMemberInviteDecline.input.shape,
  invitationPublicId:
    orgMemberInviteDecline.input.shape.invitationPublicId.describe(
      "Public ID of the invitation to decline",
    ),
};

export const metadata: ToolMetadata = {
  name: orgMemberInviteDecline.name,
  description: orgMemberInviteDecline.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function orgMemberInviteDeclineTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(orgMemberInviteDecline.name, args, ctx, {
    surface: "mcp",
  });
  return orgMemberInviteDecline.output.parse(output);
}

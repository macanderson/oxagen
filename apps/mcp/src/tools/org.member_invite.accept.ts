import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { orgMemberInviteAccept } from "@oxagen/oxagen/contracts/org.member_invite.accept";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...orgMemberInviteAccept.input.shape,
  invitationPublicId:
    orgMemberInviteAccept.input.shape.invitationPublicId.describe(
      "Public ID of the invitation to accept",
    ),
};

export const metadata: ToolMetadata = {
  name: orgMemberInviteAccept.name,
  description: orgMemberInviteAccept.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function orgMemberInviteAcceptTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(orgMemberInviteAccept.name, args, ctx, {
    surface: "mcp",
  });
  return orgMemberInviteAccept.output.parse(output);
}

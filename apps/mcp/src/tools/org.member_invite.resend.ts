import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { resendMemberInvite } from "@oxagen/oxagen/contracts/org.member_invite.resend";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
export const schema = resendMemberInvite.input.shape;
export const metadata: ToolMetadata = {
  name: resendMemberInvite.name,
  description: resendMemberInvite.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};
export default async function tool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  return resendMemberInvite.output.parse(
    await invoke(resendMemberInvite.name, args, ctx, { surface: "mcp" }),
  );
}

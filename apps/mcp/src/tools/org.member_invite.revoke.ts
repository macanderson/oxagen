import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { revokeMemberInvite } from "@oxagen/oxagen/contracts/org.member_invite.revoke";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
export const schema = revokeMemberInvite.input.shape;
export const metadata: ToolMetadata = {
  name: revokeMemberInvite.name,
  description: revokeMemberInvite.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};
export default async function tool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  return revokeMemberInvite.output.parse(
    await invoke(revokeMemberInvite.name, args, ctx, { surface: "mcp" }),
  );
}

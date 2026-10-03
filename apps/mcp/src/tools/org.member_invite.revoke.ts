import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { revokeMemberInvite } from "@oxagen/oxagen/contracts/org.member_invite.revoke";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { toolResult } from "../tool-result";
export const schema = revokeMemberInvite.input.shape;
export const metadata: ToolMetadata = {
  name: revokeMemberInvite.name,
  description: revokeMemberInvite.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
  },
};
export default async function tool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(revokeMemberInvite.name, args, ctx, {
    surface: "mcp",
  });
  return toolResult(revokeMemberInvite.output.parse(output));
}

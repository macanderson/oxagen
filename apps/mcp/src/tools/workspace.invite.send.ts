import { z } from "zod";
import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { workspaceInviteSend } from "@oxagen/oxagen/contracts/workspace.invite.send";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  email: z.string().email().describe("Email address to invite"),
  role: z
    .enum(["member", "admin", "owner"])
    .default("member")
    .describe("Role to assign: member | admin | owner. Defaults to member."),
  message: z.string().optional().describe("Optional personal message to include in the invitation"),
};

export const metadata: ToolMetadata = {
  name: workspaceInviteSend.name,
  description: workspaceInviteSend.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function workspaceInviteSendTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(workspaceInviteSend.name, args, ctx, { surface: "mcp" });
  return workspaceInviteSend.output.parse(output);
}

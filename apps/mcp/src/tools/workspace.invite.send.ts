import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { workspaceInviteSend } from "@oxagen/oxagen/contracts/workspace.invite.send";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

// Derived from the contract shape (the contract carries no field descriptions,
// so the agent-facing text is layered on here) rather than re-declaring the
// zod types locally, which would silently drift from the contract.
export const schema = {
  ...workspaceInviteSend.input.shape,
  email: workspaceInviteSend.input.shape.email.describe(
    "Email address to invite",
  ),
  role: workspaceInviteSend.input.shape.role.describe(
    "Role to assign: member | admin | owner. Defaults to member.",
  ),
  message: workspaceInviteSend.input.shape.message.describe(
    "Optional personal message to include in the invitation",
  ),
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
  const output = await invoke(workspaceInviteSend.name, args, ctx, {
    surface: "mcp",
  });
  return workspaceInviteSend.output.parse(output);
}

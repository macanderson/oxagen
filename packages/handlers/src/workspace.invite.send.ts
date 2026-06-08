import type { CapabilityHandler } from "@oxagen/oxagen";
import { workspaceInviteSend } from "@oxagen/oxagen/contracts/workspace.invite.send";

export const workspaceInviteSendHandler: CapabilityHandler<typeof workspaceInviteSend> = async (
  input,
  _ctx,
) => {
  console.log(`[stub] workspace.invite.send email=${input.email} role=${input.role}`);
  return {
    id: `inv_stub_${Date.now()}`,
    status: "pending",
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  };
};

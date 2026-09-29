import type { CapabilityHandler } from "@oxagen/oxagen";
import { orgSlackConnectionDelete } from "@oxagen/oxagen/contracts/org.slack_connection.delete";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { HandlerError } from "@oxagen/oxagen/handler-error";
import { emitSecurityEventAsync } from "@oxagen/database/security";
import { deleteSlackConnection } from "@oxagen/notifications/slack";
import { isSlackConfigured, revokeSlackTokens, toSlackConnectionView } from "./lib/slack-notices";

/**
 * delete_slack_connection: disconnect the organization's Slack workspace
 * (#4608). Owner or Admin only.
 *
 * Deletes the stored token and the channel first, then asks Slack to revoke
 * the token. The revoke is best effort: once the row is gone, Oxagen can no
 * longer post, whatever Slack answers. Deleting when nothing is connected is
 * not an error, and writes no audit row, because no credential stopped.
 */
export const handler: CapabilityHandler<typeof orgSlackConnectionDelete> = async (_input, ctx) => {
  const userId = await resolveActingUserId(ctx);
  await assertOrgRole({ ...ctx, userId }, { org: ["Owner", "Admin"] });
  if (!userId)
    throw new HandlerError({ code: "forbidden", reason: "human_authorization_required" });
  const { removedTokenEnvelopes } = await deleteSlackConnection(ctx.orgId);
  if (removedTokenEnvelopes.length > 0) {
    const revoked = await revokeSlackTokens(ctx.orgId, removedTokenEnvelopes);
    await emitSecurityEventAsync({
      eventType: "plugin.credential_revoked",
      actorUserId: userId,
      orgId: ctx.orgId,
      workspaceId: null,
      capability: orgSlackConnectionDelete.name,
      outcome: "success",
      requestId: ctx.requestId ?? null,
      ip: null,
      userAgent: null,
      detail: {
        feature: "slack_notices",
        provider: "slack",
        removed: removedTokenEnvelopes.length,
        revokedAtSlack: revoked,
      },
    });
  }
  return toSlackConnectionView(null, isSlackConfigured());
};

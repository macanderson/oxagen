import type { CapabilityHandler } from "@oxagen/oxagen";
import { orgSlackConnectionStart } from "@oxagen/oxagen/contracts/org.slack_connection.start";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { HandlerError } from "@oxagen/oxagen/handler-error";
import { beginSlackAuthorization, requireSlackAppConfig } from "./lib/slack-notices";

// audit-exempt: stores only a ten-minute state nonce; authorize_slack_connection emits plugin.credential_set when a token is stored

/**
 * start_slack_connection: begin connecting the organization's Slack
 * workspace (#4608). Stores a single-use state nonce bound to the
 * organization and the person, and returns the Slack URL that asks the
 * workspace to install the Oxagen bot. Owner or Admin only.
 */
export const handler: CapabilityHandler<typeof orgSlackConnectionStart> = async (_input, ctx) => {
  const userId = await resolveActingUserId(ctx);
  await assertOrgRole({ ...ctx, userId }, { org: ["Owner", "Admin"] });
  if (!userId)
    throw new HandlerError({ code: "forbidden", reason: "human_authorization_required" });
  const config = requireSlackAppConfig();
  return beginSlackAuthorization(config, ctx.orgId, userId);
};

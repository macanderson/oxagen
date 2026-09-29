import type { CapabilityHandler } from "@oxagen/oxagen";
import { orgSlackConnectionGet } from "@oxagen/oxagen/contracts/org.slack_connection.get";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { loadSlackConnection } from "@oxagen/notifications/slack";
import { isSlackConfigured, toSlackConnectionView } from "./lib/slack-notices";

// audit-exempt: read-only; returns the connection without its token

/**
 * get_slack_connection: the organization's Slack connection as Organization
 * settings shows it (#4608): the workspace name, the channel, and the last
 * failure a person has to fix. Never the token. Owner or Admin only.
 */
export const handler: CapabilityHandler<typeof orgSlackConnectionGet> = async (_input, ctx) => {
  const userId = await resolveActingUserId(ctx);
  await assertOrgRole({ ...ctx, userId }, { org: ["Owner", "Admin"] });
  return toSlackConnectionView(await loadSlackConnection(ctx.orgId), isSlackConfigured());
};

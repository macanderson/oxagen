import type { CapabilityHandler } from "@oxagen/oxagen";
import { orgSlackChannelSet } from "@oxagen/oxagen/contracts/org.slack_channel.set";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { HandlerError } from "@oxagen/oxagen/handler-error";
import {
  loadSlackConnection,
  setSlackChannel,
  slackChannelInfo,
} from "@oxagen/notifications/slack";
import {
  isSlackConfigured,
  openSlackTokenForHandler,
  slackHandlerError,
  toSlackConnectionView,
} from "./lib/slack-notices";

// audit-exempt: the channel choice changes where notices go, not who holds access; the token is untouched

/**
 * set_slack_channel: pick the channel steering repo health notices go to
 * (#4608). Owner or Admin only.
 *
 * The handler asks Slack for the channel itself instead of trusting a name
 * from the browser, and refuses an archived one. It clears any failure on
 * record, because a new channel is the fix for most of them. A private
 * channel still needs the Oxagen bot invited before a post can land.
 */
export const handler: CapabilityHandler<typeof orgSlackChannelSet> = async (input, ctx) => {
  const userId = await resolveActingUserId(ctx);
  await assertOrgRole({ ...ctx, userId }, { org: ["Owner", "Admin"] });
  const connection = await loadSlackConnection(ctx.orgId);
  if (connection === null)
    throw new HandlerError({ code: "conflict", reason: "slack_not_connected" });
  const token = await openSlackTokenForHandler(connection);
  let info: Awaited<ReturnType<typeof slackChannelInfo>>;
  try {
    info = await slackChannelInfo(token, input.channelId);
  } catch (err) {
    throw slackHandlerError(err);
  }
  if (info.isArchived)
    throw new HandlerError({ code: "conflict", reason: "slack_channel_archived" });
  const channel = { id: info.id, name: info.name, isPrivate: info.isPrivate };
  const saved = await setSlackChannel({ orgId: ctx.orgId, teamId: connection.teamId, channel });
  if (!saved) throw new HandlerError({ code: "conflict", reason: "slack_connection_changed" });
  return toSlackConnectionView({ ...connection, channel, lastFailure: null }, isSlackConfigured());
};

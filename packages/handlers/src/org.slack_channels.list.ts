import type { CapabilityHandler } from "@oxagen/oxagen";
import { orgSlackChannelsList } from "@oxagen/oxagen/contracts/org.slack_channels.list";
import {
  slackChannelViewSchema,
  type SlackChannelView,
} from "@oxagen/oxagen/contracts/org.slack_connection.shared";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { HandlerError } from "@oxagen/oxagen/handler-error";
import { loadSlackConnection, slackListChannels } from "@oxagen/notifications/slack";
import { openSlackTokenForHandler, slackHandlerError } from "./lib/slack-notices";

// audit-exempt: read-only; lists channel names from Slack and stores nothing

/**
 * list_slack_channels: the channels the picker offers (#4608). Reads Slack's
 * `conversations.list` with the stored bot token: every public channel, and
 * each private channel the bot was invited to. Owner or Admin only.
 *
 * A row the contract would refuse, such as a channel id of a shape Oxagen does
 * not know, is dropped rather than failing the whole list.
 */
export const handler: CapabilityHandler<typeof orgSlackChannelsList> = async (_input, ctx) => {
  const userId = await resolveActingUserId(ctx);
  await assertOrgRole({ ...ctx, userId }, { org: ["Owner", "Admin"] });
  const connection = await loadSlackConnection(ctx.orgId);
  if (connection === null)
    throw new HandlerError({ code: "conflict", reason: "slack_not_connected" });
  const token = await openSlackTokenForHandler(connection);
  let listed: Awaited<ReturnType<typeof slackListChannels>>;
  try {
    listed = await slackListChannels(token);
  } catch (err) {
    throw slackHandlerError(err);
  }
  const channels: SlackChannelView[] = [];
  for (const channel of listed.channels) {
    const parsed = slackChannelViewSchema.safeParse(channel);
    if (parsed.success) channels.push(parsed.data);
  }
  return { channels, truncated: listed.truncated };
};

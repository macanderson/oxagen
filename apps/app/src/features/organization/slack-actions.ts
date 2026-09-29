"use server";
// The Slack writes on Organization › Notifications (#4608): start a connection,
// list the channels for the picker, pick the channel, disconnect, and finish a
// connection when Slack sends the browser back. All five are organization
// scoped and `noBillingGate`, and each handler checks for Owner or Admin
// (INV-29). Each action takes the organization slug and resolves it through
// `requireViewer`, which checks the membership. No action reads an org id off
// its input (INV-19).
//
// No action returns the bot token: no contract carries it. The OAuth `code`
// and `state` cross this boundary once, inward, from the callback.
import { orgSlackChannelSet } from "@oxagen/oxagen/contracts/org.slack_channel.set";
import { orgSlackChannelsList } from "@oxagen/oxagen/contracts/org.slack_channels.list";
import { orgSlackConnectionAuthorize } from "@oxagen/oxagen/contracts/org.slack_connection.authorize";
import { orgSlackConnectionDelete } from "@oxagen/oxagen/contracts/org.slack_connection.delete";
import { orgSlackConnectionStart } from "@oxagen/oxagen/contracts/org.slack_connection.start";
import { cookies } from "next/headers";
import type { SlackChannelList } from "@/data/contracts/org";
import type { ActionResult } from "@/server/kernel";
import { kernelRead, kernelWrite, readToActionResult } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";
import { redirectToSlackAuthorization } from "@/shared/navigation";
import { parseSlackAuthorizationUrl } from "@/shared/slack-authorization-url";
import {
  SLACK_CONNECT_COOKIE,
  SLACK_CONNECT_MAX_AGE,
} from "./slack-connect-cookie";

/**
 * Connect Slack: asks for Slack's authorize URL, keeps the `state` it carries
 * in a cookie scoped to the callback, and sends the browser to Slack. It
 * answers only when it cannot send the browser anywhere.
 */
export async function startSlackConnection(
  org: string,
): Promise<ActionResult<never>> {
  const ctx = await requireViewer(org);
  const result = await kernelWrite(ctx, orgSlackConnectionStart, {});
  if (!result.ok) return result;
  const url = parseSlackAuthorizationUrl(result.value.authorizeUrl);
  if (!url)
    return {
      ok: false,
      reason: "unavailable",
      code: "slack_authorization_url_invalid",
    };
  const state = new URL(url).searchParams.get("state");
  (await cookies()).set(
    SLACK_CONNECT_COOKIE.name,
    JSON.stringify({ org: ctx.orgSlug, state }),
    {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: SLACK_CONNECT_MAX_AGE,
      path: SLACK_CONNECT_COOKIE.path,
    },
  );
  redirectToSlackAuthorization(url);
}

/**
 * The channels the picker offers, read when it opens. Slack's channel id
 * becomes `channelRef`, a foreign id (INV-11).
 */
export async function listSlackChannels(
  org: string,
): Promise<ActionResult<SlackChannelList>> {
  const ctx = await requireViewer(org);
  const result = readToActionResult(
    await kernelRead(ctx, {
      contract: orgSlackChannelsList,
      input: {},
      page: "organization",
    }),
  );
  if (!result.ok) return result;
  return {
    ok: true,
    value: {
      channels: result.value.channels.map((channel) => ({
        channelRef: channel.id,
        name: channel.name,
        isPrivate: channel.isPrivate,
      })),
      truncated: result.value.truncated,
    },
  };
}

/** Save: steering repo health notices post to this channel from now on. */
export async function setSlackChannel(
  org: string,
  channelRef: string,
): Promise<ActionResult<null>> {
  const ctx = await requireViewer(org);
  const result = await kernelWrite(ctx, orgSlackChannelSet, {
    channelId: channelRef,
  });
  return result.ok ? { ok: true, value: null } : result;
}

/** Disconnect: deletes the stored token, asks Slack to revoke it, stops posting. */
export async function disconnectSlack(
  org: string,
): Promise<ActionResult<null>> {
  const ctx = await requireViewer(org);
  const result = await kernelWrite(ctx, orgSlackConnectionDelete, {});
  return result.ok ? { ok: true, value: null } : result;
}

/**
 * Finishes a connection with the `code` Slack sent back and the `state` the
 * cookie kept. Only the OAuth callback calls it.
 */
export async function completeSlackConnection(
  org: string,
  input: { state: string; code: string },
): Promise<ActionResult<null>> {
  const ctx = await requireViewer(org);
  const result = await kernelWrite(ctx, orgSlackConnectionAuthorize, input);
  return result.ok ? { ok: true, value: null } : result;
}

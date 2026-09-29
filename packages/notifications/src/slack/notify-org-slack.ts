// notify-org-slack.ts: post one notice to the Slack channel an organization picked.
//
// The caller sends the in-app notice and the email first, then calls this.
// Three outcomes:
//
//   - The organization has no Slack connection, or no channel yet: skip.
//   - Slack refuses in a way that repeats until a person acts (the app was
//     removed, the token revoked, the channel archived or closed to the bot):
//     record the code on the connection, so Organization settings can show
//     it, and skip. Retrying cannot pass.
//   - Anything else fails (a network error, a timeout, a 429, a 5xx, a
//     refusal Oxagen does not know): throw. The steering health read leaves
//     its notified state as it was, so the next read sends the notice again.

import { ZodError } from "zod";
import { lastingDecryptFailure } from "@oxagen/crypto";
import { logger } from "../logger";
import type { NotificationKind } from "../notifications/types";
import { isPermanentSlackError, slackPostMessage } from "./slack-api";
import {
  loadSlackConnection,
  openSlackToken,
  recordSlackFailure,
  type SlackConnection,
} from "./slack-connection";

export interface NotifyOrgSlackInput {
  orgId: string;
  workspaceId?: string;
  kind: NotificationKind;
  /** One sentence. It is the message's first line and its notification text. */
  title: string;
  /** Plain text. Each line shows as a line in Slack. */
  body?: string;
  /** A path in the app, such as `/acme/steering`, or an absolute https URL. */
  deepLink?: string;
}

/** Why a notice was not posted. */
export type SlackSkipReason =
  | "not_connected"
  | "no_channel"
  | "token_unreadable"
  | "slack_refused";

export type NotifyOrgSlackResult =
  | { outcome: "posted"; channelId: string; ts: string | null }
  | { outcome: "skipped"; reason: SlackSkipReason; code?: string };

type Env = Readonly<Record<string, string | undefined>>;

/** Slack allows 3,000 characters in a section's text. Keep a margin for the markup. */
const SECTION_LIMIT = 2_900;

/** Escape the three characters Slack's mrkdwn treats as control characters. */
export function escapeSlackText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function clip(text: string): string {
  return text.length <= SECTION_LIMIT ? text : `${text.slice(0, SECTION_LIMIT - 1)}…`;
}

/**
 * The absolute URL for a deep link, or null. A path resolves against the
 * app's public URL. An absolute http or https URL passes as it is. Anything
 * else, including a protocol-relative `//host` path, is dropped.
 */
export function slackDeepLink(deepLink: string | undefined, env: Env): string | null {
  if (deepLink === undefined || deepLink === "") return null;
  if (deepLink.startsWith("/") && !deepLink.startsWith("//")) {
    const origin = env["APP_URL"] ?? env["NEXT_PUBLIC_APP_URL"];
    if (!origin) return null;
    try {
      return new URL(deepLink, origin).href;
    } catch {
      return null;
    }
  }
  try {
    const url = new URL(deepLink);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

/** The chat.postMessage text and blocks for one notice. */
export function slackNoticeMessage(
  input: Pick<NotifyOrgSlackInput, "title" | "body" | "deepLink">,
  env: Env,
): { text: string; blocks: unknown[] } {
  const blocks: unknown[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: clip(`*${escapeSlackText(input.title)}*`) },
    },
  ];
  if (input.body !== undefined && input.body.trim() !== "")
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: clip(escapeSlackText(input.body)) },
    });
  const link = slackDeepLink(input.deepLink, env);
  if (link !== null) {
    // A `|` ends the URL part of a Slack link, so it is percent-encoded.
    const target = escapeSlackText(link.replace(/\|/g, "%7C"));
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `<${target}|Open in Oxagen>` }],
    });
  }
  return { text: input.title, blocks };
}

/** Record a failure a person has to fix. A failed write is logged, not thrown. */
async function remember(connection: SlackConnection, code: string | null): Promise<void> {
  if (code === null && connection.lastFailure === null) return;
  try {
    await recordSlackFailure({
      orgId: connection.orgId,
      teamId: connection.teamId,
      failure: code === null ? null : { code, at: new Date().toISOString() },
    });
  } catch (err) {
    logger.error(
      { orgId: connection.orgId, teamId: connection.teamId, code, err },
      "[notifyOrgSlack] could not record the Slack failure on the connection",
    );
  }
}

/**
 * Post one notice to the organization's Slack channel. Skips an organization
 * with no connection or no channel. Throws when the post fails in a way a
 * retry may pass, so the caller's next attempt sends it again.
 */
export async function notifyOrgSlack(
  input: NotifyOrgSlackInput,
  env: Env = process.env,
): Promise<NotifyOrgSlackResult> {
  const { orgId, workspaceId, kind } = input;
  const connection = await loadSlackConnection(orgId);
  if (connection === null) return { outcome: "skipped", reason: "not_connected" };
  const channel = connection.channel;
  if (channel === null) {
    logger.info(
      { orgId, workspaceId, kind, teamId: connection.teamId },
      "[notifyOrgSlack] Slack is connected but no channel is picked; skipping",
    );
    return { outcome: "skipped", reason: "no_channel" };
  }

  let token: string;
  try {
    token = await openSlackToken(connection.tokenEnvelope);
  } catch (err) {
    // A malformed envelope and a key or ciphertext that will not open fail the
    // same way on every try. Anything else, such as a KMS timeout, may pass.
    if (!(err instanceof ZodError) && lastingDecryptFailure(err) === null) throw err;
    logger.error(
      { orgId, workspaceId, kind, teamId: connection.teamId, err },
      "[notifyOrgSlack] the stored Slack token does not decrypt; reconnect Slack",
    );
    await remember(connection, "token_unreadable");
    return { outcome: "skipped", reason: "token_unreadable", code: "token_unreadable" };
  }

  const message = slackNoticeMessage(input, env);
  let ts: string | null;
  try {
    ({ ts } = await slackPostMessage(token, { channel: channel.id, ...message }));
  } catch (err) {
    if (isPermanentSlackError(err)) {
      logger.warn(
        { orgId, workspaceId, kind, teamId: connection.teamId, channelId: channel.id, code: err.code },
        "[notifyOrgSlack] Slack refused the notice until someone reconnects or picks another channel",
      );
      await remember(connection, err.code);
      return { outcome: "skipped", reason: "slack_refused", code: err.code };
    }
    logger.warn(
      { orgId, workspaceId, kind, teamId: connection.teamId, channelId: channel.id, err },
      "[notifyOrgSlack] Slack post failed; the next attempt sends it again",
    );
    throw err;
  }
  await remember(connection, null);
  logger.info(
    { orgId, workspaceId, kind, teamId: connection.teamId, channelId: channel.id },
    "[notifyOrgSlack] posted",
  );
  return { outcome: "posted", channelId: channel.id, ts };
}

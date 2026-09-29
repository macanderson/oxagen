import { z } from "zod";

/**
 * Shared wire schemas for the Slack notices capabilities (#4608). Not a
 * capability itself. The start, authorize, get, list, set and delete contracts
 * all import from here, so no surface can drift on what a connection or a
 * channel looks like.
 *
 * An organization connects one Slack workspace. Oxagen keeps the bot token as
 * an encrypted organization credential and posts steering repo health changes
 * to the one channel an Owner or Admin picked. No view here carries the token.
 */

/**
 * A Slack channel id. Public channels start with `C`. Private channels start
 * with `G` on older workspaces and `C` on newer ones. A direct message (`D`)
 * is not a channel notices can go to.
 */
export const slackChannelIdSchema = z
  .string()
  .max(32)
  .regex(/^[CG][A-Z0-9]{6,}$/);

/** A channel as the picker shows it and the connection stores it. */
export const slackChannelViewSchema = z.object({
  id: slackChannelIdSchema,
  /** The channel name without the leading `#`. */
  name: z.string().min(1).max(200),
  /** A private channel needs the Oxagen bot invited before a post can land. */
  isPrivate: z.boolean(),
});

/** The last post that failed for a reason only a person can fix. */
export const slackFailureViewSchema = z.object({
  /** Slack's error code, such as `channel_not_found`, or `token_unreadable`. */
  code: z.string().min(1).max(100),
  /** When it failed, as an ISO 8601 timestamp. */
  at: z.string().min(1).max(64),
});

/**
 * An organization's Slack connection as Organization settings shows it.
 *
 * `configured` says whether this deployment holds the Slack app's client id
 * and secret. When it is false, no organization can connect, and the page
 * says so instead of offering a button that fails.
 */
export const slackConnectionViewSchema = z.object({
  configured: z.boolean(),
  connected: z.boolean(),
  /** The Slack workspace name, or null when nothing is connected. */
  teamName: z.string().min(1).max(200).nullable(),
  /** The channel notices go to, or null until one is picked. */
  channel: slackChannelViewSchema.nullable(),
  lastFailure: slackFailureViewSchema.nullable(),
  /** When the connection was made, as an ISO 8601 timestamp. */
  connectedAt: z.string().min(1).max(64).nullable(),
});

/**
 * The OAuth state nonce: 32 random bytes, base64url, 43 characters. Oxagen
 * stores it server-side for ten minutes, bound to the organization and the
 * person who started the connection, and consumes it once.
 */
export const slackOAuthStateSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export type SlackChannelView = z.output<typeof slackChannelViewSchema>;
export type SlackFailureView = z.output<typeof slackFailureViewSchema>;
export type SlackConnectionView = z.output<typeof slackConnectionViewSchema>;

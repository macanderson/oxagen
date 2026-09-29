// slack-notices.ts: what the six Slack connection handlers share (#4608).
//
// An Owner or Admin connects one Slack workspace to the organization, picks
// one channel, and Oxagen posts steering repo health changes there. The
// handlers live one per contract beside register.ts. Each asserts the role
// itself, because INV-29 reads the gate in the handler's own file. This
// module holds the parts with no role decision in them: the Slack app's
// configuration, the OAuth state nonce, the refusal codes, and the view.

import { randomBytes } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { ZodError, z } from "zod";
import { lastingDecryptFailure } from "@oxagen/crypto";
import { schema, withSystemDb } from "@oxagen/database";
import {
  SLACK_BOT_SCOPES,
  SlackApiError,
  isPermanentSlackError,
  openSlackToken,
  slackRevokeToken,
  type SlackConnection,
} from "@oxagen/notifications/slack";
import { HandlerError } from "@oxagen/oxagen/handler-error";
import type { SlackConnectionView } from "@oxagen/oxagen/contracts/org.slack_connection.shared";
import { logger } from "../logger";

/** The Oxagen Slack app's OAuth client and the app's public URL. */
export interface SlackAppConfig {
  clientId: string;
  clientSecret: string;
  /** Slack's id for the app. When set, an install from another app is refused. */
  appId: string | null;
  /** The redirect URL Slack sends the person back to. */
  redirectUri: string;
}

/** The callback route in apps/app that finishes a connection. */
export const SLACK_CALLBACK_PATH = "/api/slack/oauth/callback";

/** How long a connect link stays usable. */
const STATE_TTL_MS = 600_000;

/** The verifications row id prefix for a Slack notices OAuth state. */
const STATE_PREFIX = "slack_notices_oauth:";

const stateSchema = z.object({
  orgId: z.string().min(1),
  userId: z.string().min(1),
  redirectUri: z.string().url(),
});

type Env = Readonly<Record<string, string | undefined>>;

/** The Slack app's configuration, or null when this deployment lacks it. */
export function slackAppConfig(env: Env = process.env): SlackAppConfig | null {
  const clientId = env["SLACK_APP_CLIENT_ID"];
  const clientSecret = env["SLACK_APP_CLIENT_SECRET"];
  const appUrl = env["APP_URL"];
  if (!clientId || !clientSecret || !appUrl) return null;
  let redirectUri: string;
  try {
    redirectUri = new URL(SLACK_CALLBACK_PATH, appUrl).href;
  } catch {
    return null;
  }
  return { clientId, clientSecret, appId: env["SLACK_APP_ID"] || null, redirectUri };
}

/** Whether an organization on this deployment can connect Slack at all. */
export function isSlackConfigured(env: Env = process.env): boolean {
  return slackAppConfig(env) !== null;
}

/** The Slack app's configuration, or a refusal the settings page can explain. */
export function requireSlackAppConfig(env: Env = process.env): SlackAppConfig {
  const config = slackAppConfig(env);
  if (config === null)
    throw new HandlerError({ code: "conflict", reason: "slack_not_configured" });
  return config;
}

/**
 * Store a single-use state nonce bound to the organization and the person,
 * and return the Slack URL that asks the workspace to install the bot.
 */
export async function beginSlackAuthorization(
  config: SlackAppConfig,
  orgId: string,
  userId: string,
): Promise<{ authorizeUrl: string }> {
  const state = randomBytes(32).toString("base64url");
  const id = STATE_PREFIX + state;
  // tenancy: global OAuth state, bound to the verified orgId and the acting
  // userId, and checked against both before it is consumed.
  await withSystemDb((tx) =>
    tx.insert(schema.verifications).values({
      id,
      identifier: id,
      value: JSON.stringify({ orgId, userId, redirectUri: config.redirectUri }),
      expiresAt: new Date(Date.now() + STATE_TTL_MS),
    }),
  );
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.search = new URLSearchParams({
    client_id: config.clientId,
    scope: SLACK_BOT_SCOPES.join(","),
    redirect_uri: config.redirectUri,
    state,
  }).toString();
  return { authorizeUrl: url.href };
}

/**
 * Consume a state nonce. Refuses one that expired or was used, one that does
 * not parse, and one another organization or person started. A refused state
 * stays in place, so a person on another tab cannot spend someone else's.
 */
export async function consumeSlackState(input: {
  orgId: string;
  userId: string;
  state: string;
}): Promise<{ redirectUri: string }> {
  const id = STATE_PREFIX + input.state;
  // tenancy: global state lookup by nonce, checked against the verified orgId
  // and acting userId before the row is deleted.
  return withSystemDb(async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.verifications)
      .where(and(eq(schema.verifications.id, id), gt(schema.verifications.expiresAt, new Date())))
      .for("update");
    if (!row) throw new HandlerError({ code: "forbidden", reason: "slack_oauth_state_expired" });
    let decoded: unknown;
    try {
      decoded = JSON.parse(row.value);
    } catch {
      throw new HandlerError({ code: "forbidden", reason: "slack_oauth_state_invalid" });
    }
    const parsed = stateSchema.safeParse(decoded);
    if (!parsed.success)
      throw new HandlerError({ code: "forbidden", reason: "slack_oauth_state_invalid" });
    if (parsed.data.orgId !== input.orgId || parsed.data.userId !== input.userId)
      throw new HandlerError({ code: "forbidden", reason: "slack_oauth_state_mismatch" });
    await tx.delete(schema.verifications).where(eq(schema.verifications.id, id));
    return { redirectUri: parsed.data.redirectUri };
  });
}

/**
 * Turn a failed Slack call into what the settings page can say.
 *
 * A refusal that repeats until a person acts becomes a HandlerError with a
 * stable reason. A failure a retry may pass (a network error, a 429, a 5xx)
 * becomes a plain Error: SlackApiError carries its own `code`, and the app's
 * kernel classifies a failure by `code`, so passing it through would let a
 * Slack code read as one of Oxagen's. Anything that is not a Slack failure is
 * thrown as it came.
 */
export function slackHandlerError(err: unknown): Error {
  if (!(err instanceof SlackApiError)) return err instanceof Error ? err : new Error(String(err));
  if (isPermanentSlackError(err)) {
    if (err.code === "channel_not_found")
      return new HandlerError({ code: "not_found", reason: "slack_channel_not_found" });
    if (err.code === "is_archived")
      return new HandlerError({ code: "conflict", reason: "slack_channel_archived" });
    return new HandlerError({ code: "conflict", reason: "slack_connection_broken" });
  }
  return new Error(`Slack ${err.method} did not answer: ${err.code}`, { cause: err });
}

/**
 * Decrypt the stored bot token. A malformed envelope, or a key or ciphertext
 * that will not open, fails on every try, so it is a broken connection the
 * person fixes by reconnecting. Anything else, such as a KMS timeout, may
 * pass on a retry and is thrown as it came.
 */
export async function openSlackTokenForHandler(connection: SlackConnection): Promise<string> {
  try {
    return await openSlackToken(connection.tokenEnvelope);
  } catch (err) {
    if (err instanceof ZodError || lastingDecryptFailure(err) !== null)
      throw new HandlerError({ code: "conflict", reason: "slack_connection_broken" });
    throw err;
  }
}

/**
 * Revoke bot tokens Oxagen no longer keeps. Best effort: the row is already
 * gone, a token that will not decrypt cannot be revoked, and a person can
 * remove the app from Slack by hand. A failure is logged, never thrown.
 */
export async function revokeSlackTokens(orgId: string, envelopes: readonly unknown[]): Promise<number> {
  let revoked = 0;
  for (const envelope of envelopes) {
    try {
      await slackRevokeToken(await openSlackToken(envelope));
      revoked += 1;
    } catch (err) {
      logger.warn(
        { orgId, code: err instanceof SlackApiError ? err.code : undefined, err },
        "[slack-notices] could not revoke a Slack bot token Oxagen no longer keeps; remove the app in Slack if it stays installed",
      );
    }
  }
  return revoked;
}

/** The connection as Organization settings shows it. Carries no token. */
export function toSlackConnectionView(
  connection: SlackConnection | null,
  configured: boolean,
): SlackConnectionView {
  if (connection === null)
    return {
      configured,
      connected: false,
      teamName: null,
      channel: null,
      lastFailure: null,
      connectedAt: null,
    };
  return {
    configured,
    connected: true,
    teamName: connection.teamName,
    channel: connection.channel,
    lastFailure: connection.lastFailure,
    connectedAt: connection.connectedAt.toISOString(),
  };
}

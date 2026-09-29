// slack-connection.ts: where an organization's Slack connection lives.
//
// The bot token is an organization credential: one `ingestion.oauth_accounts`
// row with provider `slack_notices`, keyed by the Slack team id, encrypted
// with the ingestion key. The row has no refresh token and no expiry, so the
// hourly refresh job never selects it (Slack bot tokens do not expire while
// token rotation is off).
//
// What Oxagen does with the connection lives beside the organization's other
// settings, under `organizations.settings.slack_notices`: the team it belongs
// to, the channel an Owner or Admin picked, and the last post that failed for
// a reason only a person can fix. Every write to that key is guarded on the
// team id, so a write that races a reconnect to another team changes nothing.

import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { schema, withSystemDb } from "@oxagen/database";
import {
  createIngestionCryptoAdapter,
  decrypt,
  encrypt,
  resolveIngestionCryptoAdapterForKeyId,
} from "@oxagen/crypto";
import type { SlackBotInstall } from "./slack-api";

/** The `oauth_accounts.provider` value for a Slack notices bot token. */
export const SLACK_NOTICES_PROVIDER = "slack_notices";

/** The key in `organizations.settings` that holds the connection's settings. */
export const SLACK_NOTICES_SETTING = "slack_notices";

/** The channel notices go to. */
export interface SlackNoticeChannel {
  id: string;
  name: string;
  isPrivate: boolean;
}

/** The last post that failed for a reason only a person can fix. */
export interface SlackNoticeFailure {
  /** Slack's error code, such as `channel_not_found`, or `token_unreadable`. */
  code: string;
  /** When it failed, as an ISO 8601 timestamp. */
  at: string;
}

/** An organization's Slack connection, without its token. */
export interface SlackConnection {
  orgId: string;
  teamId: string;
  teamName: string;
  scopes: string[];
  channel: SlackNoticeChannel | null;
  lastFailure: SlackNoticeFailure | null;
  connectedAt: Date;
  /** The encrypted bot token. Open it with `openSlackToken`. */
  tokenEnvelope: unknown;
}

const channelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  isPrivate: z.boolean(),
});
const failureSchema = z.object({ code: z.string().min(1), at: z.string().min(1) });
const settingSchema = z.object({
  teamId: z.string().min(1),
  channel: channelSchema.nullable().catch(null),
  lastFailure: failureSchema.nullable().catch(null),
});
const envelopeSchema = z.object({
  keyId: z.string().min(1),
  ciphertext: z.string().min(1),
});

/**
 * The `organizations.settings` column, read when a query runs. Reading it when
 * the module loads would throw in any test that mocks `@oxagen/database` with
 * a partial schema and imports this module through `@oxagen/notifications`.
 */
function settingsColumn() {
  return schema.organizations.settings;
}

/** The settings column as an object, whatever it holds today. */
function settingsObject() {
  return sql`CASE WHEN jsonb_typeof(${settingsColumn()}) = 'object' THEN ${settingsColumn()} ELSE '{}'::jsonb END`;
}

/** A condition: the organization's Slack setting belongs to `teamId`. */
function ownedBy(teamId: string) {
  return sql`${settingsColumn()} -> ${SLACK_NOTICES_SETTING}::text ->> 'teamId' = ${teamId}`;
}

async function sealToken(token: string): Promise<{ keyId: string; ciphertext: string }> {
  const { adapter, keyId } = createIngestionCryptoAdapter();
  return {
    keyId,
    ciphertext: (await encrypt(token, keyId, { adapter })).toString("base64"),
  };
}

/**
 * Decrypt a stored bot token. Throws what `decrypt` throws. A caller tells a
 * lasting failure from one that may pass with `lastingDecryptFailure`.
 */
export async function openSlackToken(envelope: unknown): Promise<string> {
  const parsed = envelopeSchema.parse(envelope);
  const { adapter } = resolveIngestionCryptoAdapterForKeyId(parsed.keyId);
  const plain = await decrypt(Buffer.from(parsed.ciphertext, "base64"), parsed.keyId, {
    adapter,
  });
  return plain.toString("utf8");
}

/**
 * The organization's Slack connection, or null when it has none. A token row
 * whose team does not match the setting has no channel: the setting belongs
 * to a team the organization no longer uses.
 */
export async function loadSlackConnection(orgId: string): Promise<SlackConnection | null> {
  // tenancy: both reads are filtered by orgId, which every caller took from a
  // verified membership or from a health scope Oxagen stored for that org.
  const found = await withSystemDb(async (tx) => {
    const [account] = await tx
      .select({
        teamId: schema.oauthAccounts.providerUserId,
        teamName: schema.oauthAccounts.providerUserName,
        scopes: schema.oauthAccounts.scopes,
        tokenEnvelope: schema.oauthAccounts.accessTokenEnc,
        createdAt: schema.oauthAccounts.createdAt,
      })
      .from(schema.oauthAccounts)
      .where(
        and(
          eq(schema.oauthAccounts.orgId, orgId),
          eq(schema.oauthAccounts.provider, SLACK_NOTICES_PROVIDER),
        ),
      )
      .orderBy(desc(schema.oauthAccounts.updatedAt))
      .limit(1);
    if (!account) return null;
    const [org] = await tx
      .select({ settings: settingsColumn() })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, orgId))
      .limit(1);
    return { account, orgSettings: org?.settings };
  });
  if (found === null) return null;
  const { account, orgSettings } = found;
  const raw =
    typeof orgSettings === "object" && orgSettings !== null
      ? (orgSettings as Record<string, unknown>)[SLACK_NOTICES_SETTING]
      : undefined;
  const parsed = settingSchema.safeParse(raw);
  const setting =
    parsed.success && parsed.data.teamId === account.teamId ? parsed.data : null;
  return {
    orgId,
    teamId: account.teamId,
    teamName: account.teamName ?? account.teamId,
    scopes: account.scopes,
    channel: setting?.channel ?? null,
    lastFailure: setting?.lastFailure ?? null,
    connectedAt: account.createdAt,
    tokenEnvelope: account.tokenEnvelope,
  };
}

/**
 * Store a bot install as the organization's Slack connection. Reconnecting to
 * the same team keeps the channel and clears the last failure. Connecting to
 * another team removes the old team's token and clears the channel. Returns
 * the encrypted tokens it removed, so the caller can revoke them.
 */
export async function saveSlackConnection(input: {
  orgId: string;
  install: SlackBotInstall;
}): Promise<{ replacedTokenEnvelopes: unknown[] }> {
  const { orgId, install } = input;
  const accessTokenEnc = await sealToken(install.accessToken);
  const now = new Date();
  // tenancy: every statement is filtered by orgId, which the authorize handler
  // verified against the signed OAuth state and the caller's Owner or Admin role.
  return withSystemDb(async (tx) => {
    const replaced = await tx
      .delete(schema.oauthAccounts)
      .where(
        and(
          eq(schema.oauthAccounts.orgId, orgId),
          eq(schema.oauthAccounts.provider, SLACK_NOTICES_PROVIDER),
          sql`${schema.oauthAccounts.providerUserId} <> ${install.team.id}`,
        ),
      )
      .returning({ tokenEnvelope: schema.oauthAccounts.accessTokenEnc });
    await tx
      .insert(schema.oauthAccounts)
      .values({
        publicId: `oa_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
        orgId,
        provider: SLACK_NOTICES_PROVIDER,
        providerUserId: install.team.id,
        providerUserName: install.team.name,
        accessTokenEnc,
        refreshTokenEnc: null,
        expiresAt: null,
        tokenType: "bot",
        scopes: install.scopes,
        lastRefreshedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          schema.oauthAccounts.orgId,
          schema.oauthAccounts.provider,
          schema.oauthAccounts.providerUserId,
        ],
        set: {
          providerUserName: install.team.name,
          accessTokenEnc,
          refreshTokenEnc: null,
          expiresAt: null,
          tokenType: "bot",
          scopes: install.scopes,
          lastRefreshedAt: now,
          updatedAt: now,
          refreshFailureCount: 0,
        },
      });
    const fresh = JSON.stringify({ teamId: install.team.id, channel: null, lastFailure: null });
    await tx
      .update(schema.organizations)
      .set({
        settings: sql`jsonb_set(${settingsObject()}, ${`{${SLACK_NOTICES_SETTING}}`}::text[], CASE WHEN ${ownedBy(install.team.id)} THEN jsonb_set(${settingsColumn()} -> ${SLACK_NOTICES_SETTING}::text, '{lastFailure}', 'null'::jsonb, true) ELSE ${fresh}::jsonb END, true)`,
      })
      .where(eq(schema.organizations.id, orgId));
    return { replacedTokenEnvelopes: replaced.map((row) => row.tokenEnvelope) };
  });
}

/**
 * Set the channel notices go to and clear the last failure. Returns false when
 * the organization's connection is no longer for `teamId`, so nothing changed.
 */
export async function setSlackChannel(input: {
  orgId: string;
  teamId: string;
  channel: SlackNoticeChannel;
}): Promise<boolean> {
  const channel = JSON.stringify(channelSchema.parse(input.channel));
  // tenancy: filtered by orgId, which the handler verified against the
  // caller's Owner or Admin role, and guarded by the connection's team id.
  const rows = await withSystemDb((tx) =>
    tx
      .update(schema.organizations)
      .set({
        settings: sql`jsonb_set(jsonb_set(${settingsColumn()}, ${`{${SLACK_NOTICES_SETTING},channel}`}::text[], ${channel}::jsonb, true), ${`{${SLACK_NOTICES_SETTING},lastFailure}`}::text[], 'null'::jsonb, true)`,
      })
      .where(and(eq(schema.organizations.id, input.orgId), ownedBy(input.teamId)))
      .returning({ id: schema.organizations.id }),
  );
  return rows.length > 0;
}

/**
 * Record why the last post failed, or clear it with `failure: null`. A clear
 * writes only when a failure is on record, so a healthy post costs one read.
 */
export async function recordSlackFailure(input: {
  orgId: string;
  teamId: string;
  failure: SlackNoticeFailure | null;
}): Promise<void> {
  const value = input.failure === null ? "null" : JSON.stringify(failureSchema.parse(input.failure));
  const path = `{${SLACK_NOTICES_SETTING},lastFailure}`;
  const onlyWhenSet =
    input.failure === null
      ? sql`jsonb_typeof(${settingsColumn()} -> ${SLACK_NOTICES_SETTING}::text -> 'lastFailure') = 'object'`
      : sql`true`;
  // tenancy: filtered by orgId from the health scope Oxagen stored for that
  // org, and guarded by the connection's team id.
  await withSystemDb((tx) =>
    tx
      .update(schema.organizations)
      .set({ settings: sql`jsonb_set(${settingsColumn()}, ${path}::text[], ${value}::jsonb, true)` })
      .where(and(eq(schema.organizations.id, input.orgId), ownedBy(input.teamId), onlyWhenSet)),
  );
}

/**
 * Remove the organization's Slack connection: every token row and the
 * setting. Returns the encrypted tokens it removed, so the caller can revoke
 * them.
 */
export async function deleteSlackConnection(
  orgId: string,
): Promise<{ removedTokenEnvelopes: unknown[] }> {
  // tenancy: filtered by orgId, which the handler verified against the
  // caller's Owner or Admin role.
  return withSystemDb(async (tx) => {
    const removed = await tx
      .delete(schema.oauthAccounts)
      .where(
        and(
          eq(schema.oauthAccounts.orgId, orgId),
          eq(schema.oauthAccounts.provider, SLACK_NOTICES_PROVIDER),
        ),
      )
      .returning({ tokenEnvelope: schema.oauthAccounts.accessTokenEnc });
    await tx
      .update(schema.organizations)
      .set({ settings: sql`${settingsObject()} - ${SLACK_NOTICES_SETTING}::text` })
      .where(eq(schema.organizations.id, orgId));
    return { removedTokenEnvelopes: removed.map((row) => row.tokenEnvelope) };
  });
}

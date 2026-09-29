import type { CapabilityHandler } from "@oxagen/oxagen";
import { orgSlackConnectionAuthorize } from "@oxagen/oxagen/contracts/org.slack_connection.authorize";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { HandlerError } from "@oxagen/oxagen/handler-error";
import { emitSecurityEventAsync } from "@oxagen/database/security";
import {
  SlackApiError,
  loadSlackConnection,
  saveSlackConnection,
  slackOauthAccess,
  slackRevokeToken,
  type SlackBotInstall,
} from "@oxagen/notifications/slack";
import { logger } from "./logger";
import {
  consumeSlackState,
  requireSlackAppConfig,
  revokeSlackTokens,
  toSlackConnectionView,
} from "./lib/slack-notices";

/** Revoke a token Oxagen will not keep. Logged, never thrown. */
async function discard(orgId: string, install: SlackBotInstall, reason: string): Promise<void> {
  try {
    await slackRevokeToken(install.accessToken);
  } catch (err) {
    logger.warn(
      { orgId, teamId: install.team.id, reason, err },
      "[authorize_slack_connection] could not revoke a Slack token Oxagen refused; remove the app in Slack if it stays installed",
    );
  }
}

/**
 * authorize_slack_connection: finish connecting Slack with the code Slack
 * returned (#4608). Owner or Admin only.
 *
 * The order matters. The state nonce is consumed first, so a code arriving
 * with a state that expired, was used, or belongs to another organization or
 * person never reaches Slack. The code is exchanged next. A token from
 * another Slack app, or one without `chat:write`, is revoked and refused.
 * Only then is the token stored, encrypted, replacing any earlier
 * connection, whose token is revoked after the new one is in place.
 *
 * Every failed exchange reads as `slack_oauth_exchange_failed`, a network
 * error or a Slack outage included. The state is spent by then, and Slack
 * accepts a code once, so a second try with the same pair cannot pass. The
 * person starts again from Organization settings. The log keeps Slack's code.
 */
export const handler: CapabilityHandler<typeof orgSlackConnectionAuthorize> = async (
  input,
  ctx,
) => {
  const userId = await resolveActingUserId(ctx);
  await assertOrgRole({ ...ctx, userId }, { org: ["Owner", "Admin"] });
  if (!userId)
    throw new HandlerError({ code: "forbidden", reason: "human_authorization_required" });
  const config = requireSlackAppConfig();
  const { redirectUri } = await consumeSlackState({
    orgId: ctx.orgId,
    userId,
    state: input.state,
  });

  let install: SlackBotInstall;
  try {
    install = await slackOauthAccess({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      code: input.code,
      redirectUri,
    });
  } catch (err) {
    if (!(err instanceof SlackApiError)) throw err;
    logger.warn(
      { orgId: ctx.orgId, code: err.code },
      "[authorize_slack_connection] the Slack OAuth exchange failed",
    );
    throw new HandlerError({ code: "conflict", reason: "slack_oauth_exchange_failed" });
  }

  if (config.appId !== null && install.appId !== null && install.appId !== config.appId) {
    await discard(ctx.orgId, install, "slack_app_mismatch");
    throw new HandlerError({ code: "conflict", reason: "slack_app_mismatch" });
  }
  if (!install.scopes.includes("chat:write")) {
    await discard(ctx.orgId, install, "slack_scope_missing");
    throw new HandlerError({ code: "conflict", reason: "slack_scope_missing" });
  }

  const { replacedTokenEnvelopes } = await saveSlackConnection({ orgId: ctx.orgId, install });
  await revokeSlackTokens(ctx.orgId, replacedTokenEnvelopes);

  await emitSecurityEventAsync({
    eventType: "plugin.credential_set",
    actorUserId: userId,
    orgId: ctx.orgId,
    workspaceId: null,
    capability: orgSlackConnectionAuthorize.name,
    outcome: "success",
    requestId: ctx.requestId ?? null,
    ip: null,
    userAgent: null,
    detail: {
      feature: "slack_notices",
      provider: "slack",
      teamId: install.team.id,
      replaced: replacedTokenEnvelopes.length,
    },
  });

  return toSlackConnectionView(await loadSlackConnection(ctx.orgId), true);
};

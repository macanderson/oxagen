// The six Slack connection handlers (#4608): start, authorize, get, list,
// set and delete. Each case checks one of three things: the role gate refuses
// before any Slack call or write, the handler turns each failure into the
// reason code the settings page keys on, and no token reaches the audit row
// or the returned view.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const mocks = vi.hoisted(() => ({
  refuse: false,
  assertOrgRole: vi.fn(),
  audit: vi.fn(),
  load: vi.fn(),
  save: vi.fn(),
  setChannel: vi.fn(),
  remove: vi.fn(),
  open: vi.fn(),
  exchange: vi.fn(),
  list: vi.fn(),
  info: vi.fn(),
  revoke: vi.fn(),
  begin: vi.fn(),
  consume: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@oxagen/iam/org-role", () => ({
  resolveActingUserId: async (ctx: { userId?: string | null }) => ctx.userId ?? null,
  assertOrgRole: mocks.assertOrgRole,
  resolveActorOrgRole: async () => null,
  resolveActorWorkspaceRole: async () => null,
}));

vi.mock("@oxagen/database/security", () => ({ emitSecurityEventAsync: mocks.audit }));

// Keep the real SlackApiError and isPermanentSlackError, so each case checks
// the handler's own reading of Slack's codes.
vi.mock("@oxagen/notifications/slack", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/notifications/slack")>();
  return {
    ...real,
    loadSlackConnection: mocks.load,
    saveSlackConnection: mocks.save,
    setSlackChannel: mocks.setChannel,
    deleteSlackConnection: mocks.remove,
    openSlackToken: mocks.open,
    slackOauthAccess: mocks.exchange,
    slackListChannels: mocks.list,
    slackChannelInfo: mocks.info,
    slackRevokeToken: mocks.revoke,
  };
});

// The state nonce touches Postgres. lib/slack-notices.test.ts covers it.
vi.mock("./lib/slack-notices", async (importOriginal) => {
  const real = await importOriginal<typeof import("./lib/slack-notices")>();
  return { ...real, beginSlackAuthorization: mocks.begin, consumeSlackState: mocks.consume };
});

vi.mock("./logger", () => ({ logger: mocks.log }));

import { SlackApiError, type SlackBotInstall, type SlackConnection } from "@oxagen/notifications/slack";
import type { CapabilityContext } from "@oxagen/oxagen";
import { handler as start } from "./org.slack_connection.start";
import { handler as authorize } from "./org.slack_connection.authorize";
import { handler as get } from "./org.slack_connection.get";
import { handler as listChannels } from "./org.slack_channels.list";
import { handler as setChannel } from "./org.slack_channel.set";
import { handler as disconnect } from "./org.slack_connection.delete";
import { TEST_CTX as CTX, makeCTX } from "./test-utils/fixtures";

const STATE = "s".repeat(43);
const REDIRECT = "https://app.oxagen.sh/api/slack/oauth/callback";
const ENVELOPE = { keyId: "k", ciphertext: "c" };

function connection(over: Partial<SlackConnection> = {}): SlackConnection {
  return {
    orgId: CTX.orgId,
    teamId: "T1",
    teamName: "Acme",
    scopes: ["chat:write", "channels:read"],
    channel: { id: "C0000001", name: "alerts", isPrivate: false },
    lastFailure: null,
    connectedAt: new Date("2026-09-01T00:00:00Z"),
    tokenEnvelope: ENVELOPE,
    ...over,
  };
}

function install(over: Partial<SlackBotInstall> = {}): SlackBotInstall {
  return {
    accessToken: "xoxb-new-token",
    appId: "A1",
    botUserId: "U1",
    scopes: ["chat:write", "channels:read", "groups:read"],
    team: { id: "T1", name: "Acme" },
    ...over,
  };
}

/** The reason on a HandlerError, or the message on anything else. */
async function refusal(run: Promise<unknown>): Promise<{ code?: string; reason?: string; name?: string }> {
  const err = await run.then(
    () => {
      throw new Error("expected the handler to throw");
    },
    (e: unknown) => e,
  );
  return err as { code?: string; reason?: string; name?: string };
}

const NO_HUMAN: CapabilityContext = makeCTX({ userId: null, apiKeyId: "key_1" });

beforeEach(() => {
  mocks.refuse = false;
  mocks.assertOrgRole.mockReset().mockImplementation(async () => {
    if (mocks.refuse)
      throw Object.assign(new Error("forbidden: org role required"), {
        code: "forbidden",
        reason: "org_role_required",
      });
    return "Admin";
  });
  for (const fn of [
    mocks.audit,
    mocks.load,
    mocks.save,
    mocks.setChannel,
    mocks.remove,
    mocks.open,
    mocks.exchange,
    mocks.list,
    mocks.info,
    mocks.revoke,
    mocks.begin,
    mocks.consume,
    mocks.log.info,
    mocks.log.warn,
    mocks.log.error,
  ])
    fn.mockReset();
  mocks.open.mockResolvedValue("xoxb-stored-token");
  mocks.revoke.mockResolvedValue(undefined);
  mocks.audit.mockResolvedValue(undefined);
  vi.stubEnv("SLACK_APP_CLIENT_ID", "cid");
  vi.stubEnv("SLACK_APP_CLIENT_SECRET", "csecret");
  vi.stubEnv("SLACK_APP_ID", "A1");
  vi.stubEnv("APP_URL", "https://app.oxagen.sh");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("start_slack_connection", () => {
  it("refuses a member who is not an Owner or Admin before storing a state", async () => {
    mocks.refuse = true;
    await expect(start({}, CTX)).rejects.toMatchObject({ code: "forbidden" });
    expect(mocks.assertOrgRole).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: CTX.orgId, userId: CTX.userId }),
      { org: ["Owner", "Admin"] },
    );
    expect(mocks.begin).not.toHaveBeenCalled();
  });

  it("refuses a caller with no person behind it", async () => {
    await expect(start({}, NO_HUMAN)).rejects.toMatchObject({
      code: "forbidden",
      reason: "human_authorization_required",
    });
    expect(mocks.begin).not.toHaveBeenCalled();
  });

  it("refuses when this deployment has no Slack app", async () => {
    vi.stubEnv("SLACK_APP_CLIENT_SECRET", "");
    await expect(start({}, CTX)).rejects.toMatchObject({
      code: "conflict",
      reason: "slack_not_configured",
    });
    expect(mocks.begin).not.toHaveBeenCalled();
  });

  it("returns the Slack URL for the organization and the person", async () => {
    mocks.begin.mockResolvedValue({ authorizeUrl: "https://slack.com/oauth/v2/authorize?x=1" });
    await expect(start({}, CTX)).resolves.toEqual({
      authorizeUrl: "https://slack.com/oauth/v2/authorize?x=1",
    });
    expect(mocks.begin).toHaveBeenCalledWith(
      { clientId: "cid", clientSecret: "csecret", appId: "A1", redirectUri: REDIRECT },
      CTX.orgId,
      CTX.userId,
    );
  });
});

describe("authorize_slack_connection", () => {
  const INPUT = { state: STATE, code: "code-1" };

  beforeEach(() => {
    mocks.consume.mockResolvedValue({ redirectUri: REDIRECT });
    mocks.exchange.mockResolvedValue(install());
    mocks.save.mockResolvedValue({ replacedTokenEnvelopes: [] });
    mocks.load.mockResolvedValue(connection({ channel: null }));
  });

  it("refuses a non-admin before spending the state or calling Slack", async () => {
    mocks.refuse = true;
    await expect(authorize(INPUT, CTX)).rejects.toMatchObject({ code: "forbidden" });
    expect(mocks.consume).not.toHaveBeenCalled();
    expect(mocks.exchange).not.toHaveBeenCalled();
  });

  it("refuses a caller with no person behind it", async () => {
    await expect(authorize(INPUT, NO_HUMAN)).rejects.toMatchObject({
      reason: "human_authorization_required",
    });
    expect(mocks.consume).not.toHaveBeenCalled();
  });

  it("refuses when this deployment has no Slack app", async () => {
    vi.stubEnv("APP_URL", "");
    await expect(authorize(INPUT, CTX)).rejects.toMatchObject({ reason: "slack_not_configured" });
    expect(mocks.consume).not.toHaveBeenCalled();
  });

  it("never sends the code to Slack when the state is refused", async () => {
    mocks.consume.mockRejectedValue(
      Object.assign(new Error("forbidden"), { code: "forbidden", reason: "slack_oauth_state_mismatch" }),
    );
    await expect(authorize(INPUT, CTX)).rejects.toMatchObject({
      reason: "slack_oauth_state_mismatch",
    });
    expect(mocks.consume).toHaveBeenCalledWith({
      orgId: CTX.orgId,
      userId: CTX.userId,
      state: STATE,
    });
    expect(mocks.exchange).not.toHaveBeenCalled();
  });

  it("exchanges the code with the redirect URL stored beside the state", async () => {
    await authorize(INPUT, CTX);
    expect(mocks.exchange).toHaveBeenCalledWith({
      clientId: "cid",
      clientSecret: "csecret",
      code: "code-1",
      redirectUri: REDIRECT,
    });
  });

  it.each(["invalid_code", "network", "http_503"])(
    "reads a failed exchange (`%s`) as slack_oauth_exchange_failed and logs Slack's code",
    async (code) => {
      mocks.exchange.mockRejectedValue(new SlackApiError("oauth.v2.access", code, null));
      await expect(authorize(INPUT, CTX)).rejects.toMatchObject({
        code: "conflict",
        reason: "slack_oauth_exchange_failed",
      });
      expect(mocks.log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: CTX.orgId, code }),
        expect.any(String),
      );
      expect(mocks.save).not.toHaveBeenCalled();
    },
  );

  it("throws a failure that is not Slack's as it came", async () => {
    const boom = new Error("db down");
    mocks.exchange.mockRejectedValue(boom);
    await expect(authorize(INPUT, CTX)).rejects.toBe(boom);
  });

  it("revokes and refuses a token from another Slack app", async () => {
    mocks.exchange.mockResolvedValue(install({ appId: "A_OTHER" }));
    await expect(authorize(INPUT, CTX)).rejects.toMatchObject({
      code: "conflict",
      reason: "slack_app_mismatch",
    });
    expect(mocks.revoke).toHaveBeenCalledWith("xoxb-new-token");
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("accepts any app when SLACK_APP_ID is unset", async () => {
    vi.stubEnv("SLACK_APP_ID", "");
    mocks.exchange.mockResolvedValue(install({ appId: "A_OTHER" }));
    await expect(authorize(INPUT, CTX)).resolves.toMatchObject({ connected: true });
  });

  it("revokes and refuses a token that cannot post", async () => {
    mocks.exchange.mockResolvedValue(install({ scopes: ["channels:read"] }));
    await expect(authorize(INPUT, CTX)).rejects.toMatchObject({ reason: "slack_scope_missing" });
    expect(mocks.revoke).toHaveBeenCalledWith("xoxb-new-token");
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("still refuses, and logs, when Slack will not revoke the refused token", async () => {
    mocks.exchange.mockResolvedValue(install({ scopes: [] }));
    mocks.revoke.mockRejectedValue(new SlackApiError("auth.revoke", "network", null));
    await expect(authorize(INPUT, CTX)).rejects.toMatchObject({ reason: "slack_scope_missing" });
    expect(mocks.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "slack_scope_missing", teamId: "T1" }),
      expect.any(String),
    );
  });

  it("stores the install, revokes the token it replaced, and audits without the token", async () => {
    mocks.save.mockResolvedValue({ replacedTokenEnvelopes: [ENVELOPE] });
    const view = await authorize(INPUT, CTX);
    expect(mocks.save).toHaveBeenCalledWith({ orgId: CTX.orgId, install: install() });
    expect(mocks.open).toHaveBeenCalledWith(ENVELOPE);
    expect(mocks.revoke).toHaveBeenCalledWith("xoxb-stored-token");
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    const event = mocks.audit.mock.calls[0]![0];
    expect(event).toMatchObject({
      eventType: "plugin.credential_set",
      actorUserId: CTX.userId,
      orgId: CTX.orgId,
      workspaceId: null,
      capability: "authorize_slack_connection",
      outcome: "success",
      requestId: CTX.requestId,
      detail: { feature: "slack_notices", provider: "slack", teamId: "T1", replaced: 1 },
    });
    expect(JSON.stringify(event)).not.toContain("xoxb");
    expect(view).toEqual({
      configured: true,
      connected: true,
      teamName: "Acme",
      channel: null,
      lastFailure: null,
      connectedAt: "2026-09-01T00:00:00.000Z",
    });
    expect(JSON.stringify(view)).not.toContain("xoxb");
  });
});

describe("get_slack_connection", () => {
  it("refuses a non-admin before reading the connection", async () => {
    mocks.refuse = true;
    await expect(get({}, CTX)).rejects.toMatchObject({ code: "forbidden" });
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it("says nothing is connected, and whether the deployment can connect", async () => {
    mocks.load.mockResolvedValue(null);
    vi.stubEnv("SLACK_APP_CLIENT_ID", "");
    await expect(get({}, CTX)).resolves.toEqual({
      configured: false,
      connected: false,
      teamName: null,
      channel: null,
      lastFailure: null,
      connectedAt: null,
    });
  });

  it("returns the workspace, the channel, and the last failure, never the token", async () => {
    mocks.load.mockResolvedValue(
      connection({ lastFailure: { code: "not_in_channel", at: "2026-09-27T00:00:00.000Z" } }),
    );
    const view = await get({}, CTX);
    expect(view).toEqual({
      configured: true,
      connected: true,
      teamName: "Acme",
      channel: { id: "C0000001", name: "alerts", isPrivate: false },
      lastFailure: { code: "not_in_channel", at: "2026-09-27T00:00:00.000Z" },
      connectedAt: "2026-09-01T00:00:00.000Z",
    });
    expect(mocks.open).not.toHaveBeenCalled();
    expect(JSON.stringify(view)).not.toContain("ciphertext");
  });

  it("returns a stored connection on a deployment that lost its Slack app settings", async () => {
    // The app panel keys its manage controls on `connected`, so the view must
    // carry the connection whatever `configured` says (#4719 review).
    mocks.load.mockResolvedValue(connection());
    vi.stubEnv("SLACK_APP_CLIENT_SECRET", "");
    await expect(get({}, CTX)).resolves.toMatchObject({
      configured: false,
      connected: true,
      teamName: "Acme",
      channel: { id: "C0000001", name: "alerts", isPrivate: false },
    });
  });
});

describe("list_slack_channels", () => {
  it("refuses a non-admin before reading the token", async () => {
    mocks.refuse = true;
    await expect(listChannels({}, CTX)).rejects.toMatchObject({ code: "forbidden" });
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("refuses when nothing is connected", async () => {
    mocks.load.mockResolvedValue(null);
    await expect(listChannels({}, CTX)).rejects.toMatchObject({
      code: "conflict",
      reason: "slack_not_connected",
    });
  });

  it("reads a token that will not open as a broken connection", async () => {
    mocks.load.mockResolvedValue(connection());
    mocks.open.mockRejectedValue(new z.ZodError([]));
    await expect(listChannels({}, CTX)).rejects.toMatchObject({ reason: "slack_connection_broken" });
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("reads a revoked token as a broken connection", async () => {
    mocks.load.mockResolvedValue(connection());
    mocks.list.mockRejectedValue(new SlackApiError("conversations.list", "token_revoked", 200));
    await expect(listChannels({}, CTX)).rejects.toMatchObject({
      code: "conflict",
      reason: "slack_connection_broken",
    });
  });

  it("throws a failure a retry may pass as a plain error, not Slack's code", async () => {
    mocks.load.mockResolvedValue(connection());
    mocks.list.mockRejectedValue(new SlackApiError("conversations.list", "ratelimited", 429));
    const err = await refusal(listChannels({}, CTX));
    expect(err.name).toBe("Error");
    expect(err.code).toBeUndefined();
  });

  it("lists channels with the stored token and drops rows the contract refuses", async () => {
    mocks.load.mockResolvedValue(connection());
    mocks.list.mockResolvedValue({
      channels: [
        { id: "C0000001", name: "alerts", isPrivate: false },
        { id: "G0000002", name: "ops", isPrivate: true },
        { id: "D0000003", name: "a-direct-message", isPrivate: true },
      ],
      truncated: true,
    });
    await expect(listChannels({}, CTX)).resolves.toEqual({
      channels: [
        { id: "C0000001", name: "alerts", isPrivate: false },
        { id: "G0000002", name: "ops", isPrivate: true },
      ],
      truncated: true,
    });
    expect(mocks.list).toHaveBeenCalledWith("xoxb-stored-token");
  });
});

describe("set_slack_channel", () => {
  const INPUT = { channelId: "C0000009" };

  beforeEach(() => {
    mocks.load.mockResolvedValue(
      connection({ lastFailure: { code: "channel_not_found", at: "2026-09-27T00:00:00.000Z" } }),
    );
    mocks.info.mockResolvedValue({ id: "C0000009", name: "health", isPrivate: true, isArchived: false });
    mocks.setChannel.mockResolvedValue(true);
  });

  it("refuses a non-admin before asking Slack or writing", async () => {
    mocks.refuse = true;
    await expect(setChannel(INPUT, CTX)).rejects.toMatchObject({ code: "forbidden" });
    expect(mocks.info).not.toHaveBeenCalled();
    expect(mocks.setChannel).not.toHaveBeenCalled();
  });

  it("refuses when nothing is connected", async () => {
    mocks.load.mockResolvedValue(null);
    await expect(setChannel(INPUT, CTX)).rejects.toMatchObject({ reason: "slack_not_connected" });
  });

  it("reads a channel Slack cannot find as not found", async () => {
    mocks.info.mockRejectedValue(new SlackApiError("conversations.info", "channel_not_found", 200));
    await expect(setChannel(INPUT, CTX)).rejects.toMatchObject({
      code: "not_found",
      reason: "slack_channel_not_found",
    });
    expect(mocks.setChannel).not.toHaveBeenCalled();
  });

  it("refuses an archived channel", async () => {
    mocks.info.mockResolvedValue({ id: "C0000009", name: "old", isPrivate: false, isArchived: true });
    await expect(setChannel(INPUT, CTX)).rejects.toMatchObject({
      code: "conflict",
      reason: "slack_channel_archived",
    });
    expect(mocks.setChannel).not.toHaveBeenCalled();
  });

  it("refuses when the connection changed under the write", async () => {
    mocks.setChannel.mockResolvedValue(false);
    await expect(setChannel(INPUT, CTX)).rejects.toMatchObject({
      reason: "slack_connection_changed",
    });
  });

  it("stores the channel as Slack names it and clears the failure on record", async () => {
    const view = await setChannel(INPUT, CTX);
    expect(mocks.info).toHaveBeenCalledWith("xoxb-stored-token", "C0000009");
    expect(mocks.setChannel).toHaveBeenCalledWith({
      orgId: CTX.orgId,
      teamId: "T1",
      channel: { id: "C0000009", name: "health", isPrivate: true },
    });
    expect(view).toMatchObject({
      connected: true,
      channel: { id: "C0000009", name: "health", isPrivate: true },
      lastFailure: null,
    });
  });
});

describe("delete_slack_connection", () => {
  it("refuses a non-admin before deleting anything", async () => {
    mocks.refuse = true;
    await expect(disconnect({}, CTX)).rejects.toMatchObject({ code: "forbidden" });
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("refuses a caller with no person behind it", async () => {
    await expect(disconnect({}, NO_HUMAN)).rejects.toMatchObject({
      reason: "human_authorization_required",
    });
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("writes no audit row when nothing was connected", async () => {
    mocks.remove.mockResolvedValue({ removedTokenEnvelopes: [] });
    await expect(disconnect({}, CTX)).resolves.toMatchObject({ connected: false, configured: true });
    expect(mocks.revoke).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("deletes the token, revokes it at Slack, and audits without it", async () => {
    mocks.remove.mockResolvedValue({ removedTokenEnvelopes: [ENVELOPE] });
    await expect(disconnect({}, CTX)).resolves.toEqual({
      configured: true,
      connected: false,
      teamName: null,
      channel: null,
      lastFailure: null,
      connectedAt: null,
    });
    expect(mocks.remove).toHaveBeenCalledWith(CTX.orgId);
    expect(mocks.revoke).toHaveBeenCalledWith("xoxb-stored-token");
    const event = mocks.audit.mock.calls[0]![0];
    expect(event).toMatchObject({
      eventType: "plugin.credential_revoked",
      actorUserId: CTX.userId,
      orgId: CTX.orgId,
      workspaceId: null,
      capability: "delete_slack_connection",
      detail: { feature: "slack_notices", provider: "slack", removed: 1, revokedAtSlack: 1 },
    });
    expect(JSON.stringify(event)).not.toContain("xoxb");
  });

  it("still disconnects when Slack will not revoke, and says so in the audit", async () => {
    mocks.remove.mockResolvedValue({ removedTokenEnvelopes: [ENVELOPE] });
    mocks.revoke.mockRejectedValue(new SlackApiError("auth.revoke", "http_503", 503));
    await expect(disconnect({}, CTX)).resolves.toMatchObject({ connected: false });
    expect(mocks.audit.mock.calls[0]![0]).toMatchObject({
      detail: { removed: 1, revokedAtSlack: 0 },
    });
    expect(mocks.log.warn).toHaveBeenCalled();
  });

  it("disconnects and revokes on a deployment that lost its Slack app settings", async () => {
    vi.stubEnv("SLACK_APP_CLIENT_ID", "");
    vi.stubEnv("SLACK_APP_CLIENT_SECRET", "");
    mocks.remove.mockResolvedValue({ removedTokenEnvelopes: [ENVELOPE] });
    await expect(disconnect({}, CTX)).resolves.toMatchObject({
      configured: false,
      connected: false,
    });
    expect(mocks.remove).toHaveBeenCalledWith(CTX.orgId);
    expect(mocks.revoke).toHaveBeenCalledWith("xoxb-stored-token");
  });
});

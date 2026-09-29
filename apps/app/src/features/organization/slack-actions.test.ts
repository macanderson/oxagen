// The five Slack actions on Organization › Notifications (#4608) through the
// real kernel seam (INV-19). The viewer resolution, the kernel's invoke(), the
// cookie jar, and the redirect to Slack are the fakes, so each case shows what
// the person gets back and whether the capability ran.
//
// Three rules hold throughout: Connect Slack sends the browser only to Slack's
// own authorize page, the `state` it keeps goes in a cookie scoped to the
// callback, and no action returns anything a token could hide in.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn<typeof import("@oxagen/oxagen").invoke>(),
  requireViewer: vi.fn(),
  setCookie: vi.fn(),
  toSlack: vi.fn((url: string): never => {
    throw new Error(`REDIRECT ${url}`);
  }),
}));
vi.mock("@oxagen/oxagen", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/oxagen")>()),
  invoke: mocks.invoke,
}));
vi.mock("@oxagen/telemetry", () => ({ captureError: vi.fn() }));
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/agent/register", () => ({}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));
vi.mock("@/server/viewer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/viewer")>()),
  requireViewer: mocks.requireViewer,
}));
vi.mock("next/headers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/headers")>()),
  cookies: () => Promise.resolve({ set: mocks.setCookie }),
}));
vi.mock("@/shared/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/navigation")>()),
  redirectToSlackAuthorization: mocks.toSlack,
}));

const kernel =
  await vi.importActual<typeof import("@oxagen/oxagen")>("@oxagen/oxagen");
const { OrgCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const {
  completeSlackConnection,
  disconnectSlack,
  listSlackChannels,
  setSlackChannel,
  startSlackConnection,
} = await import("./slack-actions");

const ctx = unsafeMint(OrgCtx, {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "owner",
});

const STATE = "Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eHF1dXg";
const AUTHORIZE = `https://slack.com/oauth/v2/authorize?client_id=123.456&scope=chat%3Awrite&state=${STATE}`;
const TOKEN = "xoxb-1111-2222-secret";

const view = {
  configured: true,
  connected: true,
  teamName: "Acme",
  channel: { id: "C0123ABCD", name: "eng-alerts", isPrivate: false },
  lastFailure: null,
  connectedAt: "2026-09-28T10:00:00.000Z",
};

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.requireViewer.mockReset();
  mocks.requireViewer.mockResolvedValue(ctx);
  mocks.setCookie.mockClear();
  mocks.toSlack.mockClear();
});

describe("startSlackConnection", () => {
  it("keeps the state in a cookie scoped to the callback and sends the browser to Slack", async () => {
    mocks.invoke.mockResolvedValue({ authorizeUrl: AUTHORIZE });
    await expect(startSlackConnection("acme")).rejects.toThrow(
      `REDIRECT ${AUTHORIZE}`,
    );
    expect(mocks.requireViewer).toHaveBeenCalledWith("acme");
    expect(mocks.invoke).toHaveBeenCalledWith(
      "start_slack_connection",
      {},
      expect.anything(),
    );
    expect(mocks.setCookie).toHaveBeenCalledWith(
      "oxagen_slack_connect",
      JSON.stringify({ org: "acme", state: STATE }),
      expect.objectContaining({
        httpOnly: true,
        sameSite: "lax",
        maxAge: 600,
        path: "/api/slack/oauth/callback",
      }),
    );
    expect(mocks.toSlack).toHaveBeenCalledWith(AUTHORIZE);
  });

  it.each([
    ["another host", `https://evil.example/oauth/v2/authorize?state=${STATE}`],
    ["another Slack page", `https://slack.com/signin?state=${STATE}`],
    ["no state", "https://slack.com/oauth/v2/authorize?client_id=123.456"],
    ["a fragment", `${AUTHORIZE}#top`],
  ])(
    "refuses an authorize URL on %s, with no cookie and no redirect (negative)",
    async (_, authorizeUrl) => {
      mocks.invoke.mockResolvedValue({ authorizeUrl });
      const out = await startSlackConnection("acme");
      expect(out).toEqual({
        ok: false,
        reason: "unavailable",
        code: "slack_authorization_url_invalid",
      });
      expect(mocks.setCookie).not.toHaveBeenCalled();
      expect(mocks.toSlack).not.toHaveBeenCalled();
    },
  );

  it("answers a role refusal as denied, with no cookie and no redirect (negative)", async () => {
    mocks.invoke.mockRejectedValue(
      new kernel.CapabilityError(
        "start_slack_connection",
        "authz_denied",
        "Forbidden",
      ),
    );
    const out = await startSlackConnection("acme");
    expect(out).toMatchObject({
      ok: false,
      reason: "denied",
      code: "authz_denied",
    });
    expect(mocks.setCookie).not.toHaveBeenCalled();
    expect(mocks.toSlack).not.toHaveBeenCalled();
  });

  it("carries a deployment with no Slack app as the handler's code (negative)", async () => {
    mocks.invoke.mockRejectedValue(
      new kernel.HandlerError({
        code: "conflict",
        reason: "slack_not_configured",
      }),
    );
    const out = await startSlackConnection("acme");
    expect(out).toMatchObject({
      ok: false,
      reason: "conflict",
      code: "slack_not_configured",
    });
    expect(mocks.setCookie).not.toHaveBeenCalled();
  });
});

describe("listSlackChannels", () => {
  it("names each Slack channel id channelRef and keeps the truncated flag", async () => {
    mocks.invoke.mockResolvedValue({
      channels: [
        { id: "C0123ABCD", name: "eng-alerts", isPrivate: false },
        { id: "G0456DEFG", name: "security", isPrivate: true },
      ],
      truncated: true,
    });
    const out = await listSlackChannels("acme");
    expect(mocks.invoke).toHaveBeenCalledWith(
      "list_slack_channels",
      {},
      expect.anything(),
    );
    expect(out).toEqual({
      ok: true,
      value: {
        channels: [
          { channelRef: "C0123ABCD", name: "eng-alerts", isPrivate: false },
          { channelRef: "G0456DEFG", name: "security", isPrivate: true },
        ],
        truncated: true,
      },
    });
  });

  it("answers a role refusal with the permission the Organization page needs (negative)", async () => {
    mocks.invoke.mockRejectedValue(
      new kernel.CapabilityError(
        "list_slack_channels",
        "authz_denied",
        "Forbidden",
      ),
    );
    const out = await listSlackChannels("acme");
    expect(out).toMatchObject({
      ok: false,
      reason: "denied",
      code: "org.admin",
    });
  });

  it("keeps the handler's code for a connection Slack no longer accepts (negative)", async () => {
    mocks.invoke.mockRejectedValue(
      new kernel.HandlerError({
        code: "conflict",
        reason: "slack_connection_broken",
      }),
    );
    const out = await listSlackChannels("acme");
    expect(out).toMatchObject({
      ok: false,
      reason: "conflict",
      code: "slack_connection_broken",
    });
  });
});

describe("setSlackChannel", () => {
  it("sends the picked channel as the channel id and answers with nothing", async () => {
    mocks.invoke.mockResolvedValue(view);
    const out = await setSlackChannel("acme", "C0123ABCD");
    expect(mocks.invoke).toHaveBeenCalledWith(
      "set_slack_channel",
      { channelId: "C0123ABCD" },
      expect.anything(),
    );
    expect(out).toEqual({ ok: true, value: null });
  });

  it("refuses a direct message id before any capability runs (negative)", async () => {
    const out = await setSlackChannel("acme", "D0123ABCD");
    expect(out).toMatchObject({
      ok: false,
      reason: "invalid",
      field: "channelId",
    });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("answers a channel Slack no longer has as not_found with the handler's code (negative)", async () => {
    mocks.invoke.mockRejectedValue(
      new kernel.HandlerError({
        code: "not_found",
        reason: "slack_channel_not_found",
      }),
    );
    const out = await setSlackChannel("acme", "C0123ABCD");
    expect(out).toMatchObject({
      ok: false,
      reason: "not_found",
      code: "slack_channel_not_found",
    });
  });
});

describe("disconnectSlack", () => {
  it("deletes the connection and answers with nothing", async () => {
    mocks.invoke.mockResolvedValue({
      ...view,
      connected: false,
      teamName: null,
      channel: null,
      connectedAt: null,
    });
    const out = await disconnectSlack("acme");
    expect(mocks.invoke).toHaveBeenCalledWith(
      "delete_slack_connection",
      {},
      expect.anything(),
    );
    expect(out).toEqual({ ok: true, value: null });
  });
});

describe("completeSlackConnection", () => {
  it("finishes the connection with the state and the code, and answers with nothing", async () => {
    mocks.invoke.mockResolvedValue(view);
    const out = await completeSlackConnection("acme", {
      state: STATE,
      code: "slack-oauth-code-7f3a",
    });
    expect(mocks.requireViewer).toHaveBeenCalledWith("acme");
    expect(mocks.invoke).toHaveBeenCalledWith(
      "authorize_slack_connection",
      { state: STATE, code: "slack-oauth-code-7f3a" },
      expect.anything(),
    );
    expect(out).toEqual({ ok: true, value: null });
  });

  it("refuses a state Oxagen could not have issued before any capability runs (negative)", async () => {
    const out = await completeSlackConnection("acme", {
      state: "short",
      code: "slack-oauth-code-7f3a",
    });
    expect(out).toMatchObject({ ok: false, reason: "invalid", field: "state" });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("carries the handler's code for a state that expired (negative)", async () => {
    mocks.invoke.mockRejectedValue(
      new kernel.HandlerError({
        code: "forbidden",
        reason: "slack_oauth_state_expired",
      }),
    );
    const out = await completeSlackConnection("acme", {
      state: STATE,
      code: "slack-oauth-code-7f3a",
    });
    expect(out).toMatchObject({
      ok: false,
      reason: "denied",
      code: "slack_oauth_state_expired",
    });
  });
});

describe("the token", () => {
  it("never reaches the browser, even when a handler answers with one", async () => {
    // A handler that broke the contract and sent the token back would still
    // be answered with nothing: each write drops the record it got.
    mocks.invoke.mockResolvedValue({ ...view, botToken: TOKEN });
    const outs = [
      await setSlackChannel("acme", "C0123ABCD"),
      await disconnectSlack("acme"),
      await completeSlackConnection("acme", {
        state: STATE,
        code: "slack-oauth-code-7f3a",
      }),
    ];
    for (const out of outs) expect(JSON.stringify(out)).not.toContain(TOKEN);
  });
});

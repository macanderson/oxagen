// The Slack OAuth callback (#4608): what the browser gets back for each way a
// connection attempt can end. The cookie jar and the finishing write are the
// fakes; the redirect is the real one, so each case reads the Location the
// browser would follow.
//
// Two rules hold on every path: the cookie is deleted on its first read, and
// neither the `code` nor the `state` appears in a Location or a body.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  complete: vi.fn(),
}));
vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({ get: mocks.get, set: mocks.set }),
}));
vi.mock("./slack-actions", () => ({
  completeSlackConnection: mocks.complete,
}));

const { handleSlackCallback } = await import("./slack-callback");

const STATE = "s".repeat(43);
const CODE = "slack-oauth-code-7f3a";
const CALLBACK = "https://app.oxagen.sh/api/slack/oauth/callback";

function cookieOf(value: unknown) {
  return { value: JSON.stringify(value) };
}

function callback(query: Record<string, string>) {
  return handleSlackCallback(
    new Request(`${CALLBACK}?${new URLSearchParams(query).toString()}`),
  );
}

/** The page the browser is sent to, as path, tab, and outcome. */
function landing(res: Response) {
  const target = new URL(res.headers.get("location") ?? "");
  return {
    path: target.pathname,
    tab: target.searchParams.get("tab"),
    slack: target.searchParams.get("slack"),
  };
}

/** Neither Slack secret in anything the browser receives. */
async function expectNoSecrets(res: Response) {
  const seen = `${res.headers.get("location") ?? ""} ${await res.text()}`;
  expect(seen).not.toContain(CODE);
  expect(seen).not.toContain(STATE);
}

function expectCookieCleared() {
  expect(mocks.set).toHaveBeenCalledWith(
    "oxagen_slack_connect",
    "",
    expect.objectContaining({
      maxAge: 0,
      httpOnly: true,
      path: "/api/slack/oauth/callback",
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockReturnValue(cookieOf({ org: "acme", state: STATE }));
  mocks.complete.mockResolvedValue({ ok: true, value: null });
});

describe("handleSlackCallback", () => {
  it("finishes the connection with the code and the state the cookie kept, and returns to Notifications as connected", async () => {
    const res = await callback({ code: CODE, state: STATE });
    expect(mocks.complete).toHaveBeenCalledWith("acme", {
      state: STATE,
      code: CODE,
    });
    expect(res.status).toBe(307);
    expect(landing(res)).toEqual({
      path: "/acme",
      tab: "notifications",
      slack: "connected",
    });
    expectCookieCleared();
    await expectNoSecrets(res);
  });

  it("reads Cancel on Slack as cancelled and finishes nothing (negative)", async () => {
    const res = await callback({ error: "access_denied", state: STATE });
    expect(landing(res).slack).toBe("cancelled");
    expect(mocks.complete).not.toHaveBeenCalled();
    expectCookieCleared();
    await expectNoSecrets(res);
  });

  it("reads a state that differs from the cookie's as expired and finishes nothing (negative)", async () => {
    const other = "o".repeat(43);
    const res = await callback({ code: CODE, state: other });
    expect(landing(res).slack).toBe("expired");
    expect(mocks.complete).not.toHaveBeenCalled();
    expectCookieCleared();
    expect(res.headers.get("location")).not.toContain(other);
    await expectNoSecrets(res);
  });

  it("reads a missing code as expired and finishes nothing (negative)", async () => {
    const res = await callback({ state: STATE });
    expect(landing(res).slack).toBe("expired");
    expect(mocks.complete).not.toHaveBeenCalled();
    expectCookieCleared();
  });

  it("reads a code longer than the contract accepts as expired and finishes nothing (negative)", async () => {
    const res = await callback({ code: "c".repeat(513), state: STATE });
    expect(landing(res).slack).toBe("expired");
    expect(mocks.complete).not.toHaveBeenCalled();
    expectCookieCleared();
  });

  it("answers a plain 400 when no cookie names the organization (negative)", async () => {
    mocks.get.mockReturnValue(undefined);
    const res = await callback({ code: CODE, state: STATE });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(mocks.complete).not.toHaveBeenCalled();
    expectCookieCleared();
    await expectNoSecrets(res);
  });

  it("answers a plain 400 for a cookie that is not JSON (negative)", async () => {
    mocks.get.mockReturnValue({ value: "{not json" });
    const res = await callback({ code: CODE, state: STATE });
    expect(res.status).toBe(400);
    expect(mocks.complete).not.toHaveBeenCalled();
    expectCookieCleared();
    await expectNoSecrets(res);
  });

  it("answers a plain 400 for a cookie whose state is not one Oxagen issued (negative)", async () => {
    mocks.get.mockReturnValue(cookieOf({ org: "acme", state: "short" }));
    const res = await callback({ code: CODE, state: "short" });
    expect(res.status).toBe(400);
    expect(mocks.complete).not.toHaveBeenCalled();
    expectCookieCleared();
  });

  it.each([
    ["slack_oauth_state_expired", "denied", "expired"],
    ["slack_oauth_state_mismatch", "denied", "expired"],
    ["slack_oauth_exchange_failed", "conflict", "refused"],
    ["slack_scope_missing", "conflict", "refused"],
    ["slack_not_configured", "conflict", "notConfigured"],
    ["org.admin", "denied", "denied"],
    ["kernel_failure", "unavailable", "unavailable"],
  ])(
    "reads a refused finish with code %s (%s) as %s (negative)",
    async (code, reason, outcome) => {
      mocks.complete.mockResolvedValue({ ok: false, reason, code });
      const res = await callback({ code: CODE, state: STATE });
      expect(landing(res)).toEqual({
        path: "/acme",
        tab: "notifications",
        slack: outcome,
      });
      expectCookieCleared();
      await expectNoSecrets(res);
    },
  );

  it("reads a finish that waits on approval as pendingApproval", async () => {
    mocks.complete.mockResolvedValue({
      ok: false,
      reason: "pending_approval",
      accessRequestId: "areq_1",
    });
    const res = await callback({ code: CODE, state: STATE });
    expect(landing(res).slack).toBe("pendingApproval");
  });

  it("reads a finish refused for spend as unavailable", async () => {
    mocks.complete.mockResolvedValue({
      ok: false,
      reason: "exhausted",
      code: "billing_suspended",
    });
    const res = await callback({ code: CODE, state: STATE });
    expect(landing(res).slack).toBe("unavailable");
  });
});

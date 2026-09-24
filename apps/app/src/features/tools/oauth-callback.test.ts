// The OAuth callback (#4132): it completes only a flow this browser started,
// spends the flow's state whatever happens, completes as the viewer of the
// workspace that started it, and answers with a page that posts the outcome
// back to the wizard. The page never echoes the code and is never cached.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { translator } from "@/test/intl";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  complete: vi.fn(),
}));
vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({ get: mocks.get, set: mocks.set }),
}));
vi.mock("next-intl/server", () => ({
  getTranslations: (namespace: string) =>
    Promise.resolve(translator(namespace)),
}));
vi.mock("./provider-auth-actions", () => ({
  completeProviderAuthorization: mocks.complete,
}));

const { handleMcpOAuthCallback } = await import("./oauth-callback");
const { pendingFlowsOf } = await import("./oauth-flow");

const STATE = "a".repeat(32);
const OTHER = "b".repeat(32);
const BASE = "https://app.oxagen.sh/api/v1/mcp/oauth/callback";

function request(query: string): Request {
  return new Request(`${BASE}?${query}`);
}

/** The outcome the page posts, read back out of its script. */
function outcomeOf(html: string): unknown {
  const match = /var m=(\{.*?\});try/.exec(html);
  if (match?.[1] === undefined) throw new Error("no outcome in the page");
  const outcome: unknown = JSON.parse(match[1]);
  return outcome;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockReturnValue({
    value: JSON.stringify([
      { org: "acme", ws: "core", state: STATE },
      { org: "acme", ws: "core", state: OTHER },
    ]),
  });
  mocks.complete.mockResolvedValue({
    ok: true,
    value: {
      serverId: "mcs_linear",
      name: "Linear <b>",
      healthStatus: "healthy",
      discoveredTools: ["list_issues"],
    },
  });
});

describe("MCP OAuth callback", () => {
  it("completes a flow this browser started, as its workspace's viewer, and posts the provider back", async () => {
    const res = await handleMcpOAuthCallback(
      request(`state=${STATE}&code=the-code`),
    );
    expect(mocks.complete).toHaveBeenCalledWith("acme", "core", {
      state: STATE,
      code: "the-code",
    });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await res.text();
    expect(outcomeOf(html)).toEqual({
      type: "oxagen:mcp-oauth",
      ok: true,
      state: STATE,
      serverId: "mcs_linear",
      name: "Linear <b>",
      healthStatus: "healthy",
      discoveredTools: ["list_issues"],
    });
    // The provider's name is escaped in the page and the code is never in it.
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("the-code");
    expect(html).toContain("oxagen-mcp-oauth");
  });

  it("spends the state and keeps the other flows", async () => {
    await handleMcpOAuthCallback(request(`state=${STATE}&code=c`));
    const call = mocks.set.mock.calls[0] ?? [];
    expect(call[0]).toBe("oxagen_mcp_oauth");
    expect(pendingFlowsOf(String(call[1])).map((f) => f.state)).toEqual([
      OTHER,
    ]);
    expect(call[2]).toMatchObject({
      path: "/api/v1/mcp/oauth/callback",
      httpOnly: true,
    });
  });

  it("refuses a state this browser did not start, without completing anything", async () => {
    const res = await handleMcpOAuthCallback(
      request(`state=${"z".repeat(32)}&code=c`),
    );
    expect(outcomeOf(await res.text())).toMatchObject({
      ok: false,
      code: "authorization_expired",
    });
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("names a declined sign-in, and spends its state", async () => {
    const res = await handleMcpOAuthCallback(
      request(`state=${STATE}&error=access_denied`),
    );
    const html = await res.text();
    expect(outcomeOf(html)).toMatchObject({ ok: false, code: "access_denied" });
    expect(html).toContain(translator("tools.oauthCallback")("denied"));
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.set).toHaveBeenCalled();
  });

  it("names any other provider error as a failed sign-in, and a missing code too", async () => {
    let res = await handleMcpOAuthCallback(
      request(`state=${STATE}&error=server_error`),
    );
    expect(outcomeOf(await res.text())).toMatchObject({
      code: "authorization_failed",
    });
    res = await handleMcpOAuthCallback(request(`state=${STATE}`));
    expect(outcomeOf(await res.text())).toMatchObject({
      code: "authorization_failed",
    });
  });

  it("carries a refused completion's code back to the wizard", async () => {
    mocks.complete.mockResolvedValue({
      ok: false,
      reason: "not_found",
      code: "authorization_expired",
    });
    let res = await handleMcpOAuthCallback(request(`state=${STATE}&code=c`));
    expect(outcomeOf(await res.text())).toMatchObject({
      code: "authorization_expired",
    });
    mocks.complete.mockResolvedValue({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
    });
    res = await handleMcpOAuthCallback(request(`state=${STATE}&code=c`));
    expect(outcomeOf(await res.text())).toMatchObject({
      code: "invalid_input",
    });
    mocks.complete.mockRejectedValue(new Error("boom"));
    res = await handleMcpOAuthCallback(request(`state=${STATE}&code=c`));
    expect(outcomeOf(await res.text())).toMatchObject({
      code: "authorization_failed",
    });
  });

  it("reads an unreadable cookie as no flows", async () => {
    mocks.get.mockReturnValue({ value: "not json" });
    const res = await handleMcpOAuthCallback(request(`state=${STATE}&code=c`));
    expect(outcomeOf(await res.text())).toMatchObject({
      code: "authorization_expired",
    });
    expect(pendingFlowsOf(undefined)).toEqual([]);
    expect(
      pendingFlowsOf(JSON.stringify([{ org: "a", ws: "b", state: "short" }])),
    ).toEqual([]);
  });
});

/**
 * route.test.ts — regression tests for POST /api/v1/agent/subagent/logs.
 *
 * Mirrors ../result/route.test.ts's conventions (same auth/scope shape).
 * Unlike its sibling GET routes, this POST route has no not-found predicate —
 * get_subagent_logs failures all fall through the generic 500 catch-all, so
 * that branch is covered directly (no SubagentRunNotFoundError special case).
 * Covers: 401 unauth, 400 invalid JSON, 400 zod-invalid body, 404 unknown/
 * denied workspace, 200 success (with and without optional title), and the
 * 500 catch-all.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetSessionOrRedirect, mockResolveWorkspaceScope, mockInvoke, mockConsoleError } =
  vi.hoisted(() => ({
    mockGetSessionOrRedirect: vi.fn(),
    mockResolveWorkspaceScope: vi.fn(),
    mockInvoke: vi.fn(),
    mockConsoleError: vi.fn(),
  }));

vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/agent/register", () => ({}));
vi.mock("@/lib/session", () => ({
  getSessionOrRedirect: mockGetSessionOrRedirect,
}));
vi.mock("@/lib/resolve-org", () => ({
  resolveWorkspaceScope: mockResolveWorkspaceScope,
}));
vi.mock("@oxagen/oxagen", () => ({
  invoke: mockInvoke,
}));
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: (_scope: unknown, fn: () => unknown) => fn(),
}));

import { POST } from "./route";

const SESSION = { user: { id: "user-1" } };
const SCOPE = { orgId: "org-1", workspaceId: "ws-1" };

function req(body: unknown): Request {
  return new Request("https://app.oxagen.sh/api/v1/agent/subagent/logs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function rawReq(body: string): Request {
  return new Request("https://app.oxagen.sh/api/v1/agent/subagent/logs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(mockConsoleError);
  mockGetSessionOrRedirect.mockResolvedValue(SESSION);
  mockResolveWorkspaceScope.mockResolvedValue(SCOPE);
  mockInvoke.mockResolvedValue({ url: "https://app.oxagen.sh/logs/fanout-1.md" });
});

describe("POST /api/v1/agent/subagent/logs", () => {
  it("returns 401 when there is no session", async () => {
    mockGetSessionOrRedirect.mockRejectedValueOnce(new Error("no session"));

    const res = await POST(req({ workspaceId: "ws-1", fanoutId: "fanout-1" }) as never);

    expect(res.status).toBe(401);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid JSON body", async () => {
    const res = await POST(rawReq("{ not json") as never);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Invalid JSON body");
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("returns 400 when the body is missing required fields", async () => {
    const res = await POST(req({ workspaceId: "ws-1" }) as never);

    expect(res.status).toBe(400);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("returns 400 when fanoutId is empty", async () => {
    const res = await POST(req({ workspaceId: "ws-1", fanoutId: "" }) as never);

    expect(res.status).toBe(400);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("returns 404 when the workspace is unknown or membership is denied", async () => {
    mockResolveWorkspaceScope.mockResolvedValueOnce(null);

    const res = await POST(req({ workspaceId: "ws-1", fanoutId: "fanout-1" }) as never);

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Workspace not found");
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("returns 200 with the invoke() result on success (no title)", async () => {
    const payload = { url: "https://app.oxagen.sh/logs/fanout-1.md" };
    mockInvoke.mockResolvedValueOnce(payload);

    const res = await POST(req({ workspaceId: "ws-1", fanoutId: "fanout-1" }) as never);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(payload);
    expect(mockInvoke).toHaveBeenCalledWith(
      "get_subagent_logs",
      { fanoutId: "fanout-1", title: undefined },
      expect.objectContaining({
        orgId: SCOPE.orgId,
        workspaceId: SCOPE.workspaceId,
        userId: SESSION.user.id,
        surface: "app",
      }),
      { surface: "agent" },
    );
  });

  it("passes an optional title through to get_subagent_logs", async () => {
    await POST(
      req({ workspaceId: "ws-1", fanoutId: "fanout-1", title: "My Fanout" }) as never,
    );

    expect(mockInvoke).toHaveBeenCalledWith(
      "get_subagent_logs",
      { fanoutId: "fanout-1", title: "My Fanout" },
      expect.anything(),
      { surface: "agent" },
    );
  });

  it("returns a logged 500 when invoke() throws (no not-found special case)", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("fanout not found"));

    const res = await POST(req({ workspaceId: "ws-1", fanoutId: "fanout-1" }) as never);

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Failed to generate logfile");
    expect(mockConsoleError).toHaveBeenCalledTimes(1);
  });
});

/**
 * route.test.ts — regression tests for GET /api/v1/agent/subagent/result.
 *
 * Mirrors graph/explore/route.test.ts's conventions but for a route scoped via
 * `resolveWorkspaceScope` (workspaceId query param, not org/workspace slugs).
 * Covers: 401 unauth, 400 invalid query, 404 unknown/denied workspace, 404
 * when get_subagent_result throws SubagentRunNotFoundError, 200 success, and
 * the 500 catch-all for any other invoke() failure.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SubagentRunNotFoundError } from "@oxagen/agent";

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

import { GET } from "./route";

const SESSION = { user: { id: "user-1" } };
const SCOPE = { orgId: "org-1", workspaceId: "ws-1" };

function req(params: Record<string, string>): Request {
  const url = new URL("https://app.oxagen.sh/api/v1/agent/subagent/result");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new Request(url);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(mockConsoleError);
  mockGetSessionOrRedirect.mockResolvedValue(SESSION);
  mockResolveWorkspaceScope.mockResolvedValue(SCOPE);
  mockInvoke.mockResolvedValue({ runId: "run-1", input: {}, output: {} });
});

describe("GET /api/v1/agent/subagent/result", () => {
  it("returns 401 when there is no session", async () => {
    mockGetSessionOrRedirect.mockRejectedValueOnce(new Error("no session"));

    const res = await GET(req({ workspaceId: "ws-1", runId: "run-1" }) as never);

    expect(res.status).toBe(401);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("returns 400 when the query is missing required params", async () => {
    const res = await GET(req({ workspaceId: "ws-1" }) as never);

    expect(res.status).toBe(400);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("returns 400 when a required param is empty", async () => {
    const res = await GET(req({ workspaceId: "", runId: "run-1" }) as never);

    expect(res.status).toBe(400);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("returns 404 when the workspace is unknown or membership is denied", async () => {
    mockResolveWorkspaceScope.mockResolvedValueOnce(null);

    const res = await GET(req({ workspaceId: "ws-1", runId: "run-1" }) as never);

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Workspace not found");
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("returns 404 when get_subagent_result throws SubagentRunNotFoundError", async () => {
    mockInvoke.mockRejectedValueOnce(new SubagentRunNotFoundError("run-1"));

    const res = await GET(req({ workspaceId: "ws-1", runId: "run-1" }) as never);

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Subagent run not found");
  });

  it("returns 200 with the invoke() result on success", async () => {
    const payload = { runId: "run-1", input: { foo: "bar" }, output: { ok: true } };
    mockInvoke.mockResolvedValueOnce(payload);

    const res = await GET(req({ workspaceId: "ws-1", runId: "run-1" }) as never);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(payload);
    expect(mockInvoke).toHaveBeenCalledWith(
      "get_subagent_result",
      { runId: "run-1" },
      expect.objectContaining({
        orgId: SCOPE.orgId,
        workspaceId: SCOPE.workspaceId,
        userId: SESSION.user.id,
        surface: "app",
      }),
      { surface: "agent" },
    );
  });

  it("returns a logged 500 when invoke() throws an unrelated error", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("neo4j down"));

    const res = await GET(req({ workspaceId: "ws-1", runId: "run-1" }) as never);

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Failed to load subagent result");
    expect(mockConsoleError).toHaveBeenCalledTimes(1);
  });
});

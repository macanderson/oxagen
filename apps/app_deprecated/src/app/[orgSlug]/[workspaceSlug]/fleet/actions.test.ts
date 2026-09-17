/**
 * actions.test.ts — unit tests for the Fleet screen's one read.
 *
 * What these are here to hold down, in order of what went wrong:
 *
 *   1. The workspace-membership gate. `resolveWorkspace` proves the slug
 *      belongs to the org and nothing about whether the caller has a
 *      `workspace_users` row in it. `[workspaceSlug]/layout.tsx` asserts that
 *      for a page render, but a Server Action is a POST straight to this
 *      function and never runs a layout, so without the assert any member of a
 *      multi-workspace org could enumerate a sibling workspace's machines by
 *      posting its slug.
 *   2. That the gate runs BEFORE `invoke`, not beside it.
 *   3. That the guards sit outside the try. Each signals by throwing a Next.js
 *      control-flow error, and a catch around them turned a 401 redirect and a
 *      404 into "Could not load the fleet".
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetSession,
  mockResolveOrg,
  mockResolveWorkspace,
  mockAssertOrgMember,
  mockAssertWorkspaceMember,
  mockRunInTenantScope,
  mockInvoke,
  calls,
} = vi.hoisted(() => {
  const calls: string[] = [];
  return {
    calls,
    mockGetSession: vi.fn(),
    mockResolveOrg: vi.fn(),
    mockResolveWorkspace: vi.fn(),
    mockAssertOrgMember: vi.fn(() => {
      calls.push("assertOrgMember");
    }),
    mockAssertWorkspaceMember: vi.fn(() => {
      calls.push("assertWorkspaceMember");
    }),
    mockRunInTenantScope: vi.fn((_scope: unknown, fn: () => unknown) => fn()),
    // Typed as (...unknown[]) => unknown so the hoisted factory does not
    // narrow the return to the first literal it sees; each test supplies the
    // shape it needs.
    mockInvoke: vi.fn((..._args: unknown[]): unknown => {
      calls.push("invoke");
      return { hosts: [], nextCursor: null };
    }),
  };
});

vi.mock("@/lib/session", () => ({ getSessionOrRedirect: mockGetSession }));
vi.mock("@/lib/resolve-org", () => ({
  resolveOrg: mockResolveOrg,
  resolveWorkspace: mockResolveWorkspace,
  assertOrgMember: mockAssertOrgMember,
  assertWorkspaceMember: mockAssertWorkspaceMember,
}));
vi.mock("@oxagen/tenancy", () => ({ runInTenantScope: mockRunInTenantScope }));
vi.mock("@oxagen/oxagen", () => ({ invoke: mockInvoke }));
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/handlers/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { listFleetAction } from "./actions";

const SESSION = { user: { id: "user-1" } };
const ORG = { id: "org-1", slug: "acme" };
const WS = { id: "ws-1", slug: "core" };

const HOST = {
  publicId: "tch_abcdefghijklmnopqrstuv",
  hostname: "laptop",
  status: "active",
};

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  mockGetSession.mockResolvedValue(SESSION);
  mockResolveOrg.mockResolvedValue(ORG);
  mockResolveWorkspace.mockResolvedValue(WS);
  mockAssertOrgMember.mockImplementation(() => {
    calls.push("assertOrgMember");
  });
  mockAssertWorkspaceMember.mockImplementation(() => {
    calls.push("assertWorkspaceMember");
  });
  mockInvoke.mockImplementation((): unknown => {
    calls.push("invoke");
    return { hosts: [HOST], nextCursor: null };
  });
});

describe("listFleetAction", () => {
  it("asserts workspace membership, with the workspace id and the session user", async () => {
    await listFleetAction({ orgSlug: "acme", workspaceSlug: "core" });
    expect(mockAssertWorkspaceMember).toHaveBeenCalledWith(WS.id, SESSION.user.id);
  });

  it("asserts membership before it invokes anything", async () => {
    await listFleetAction({ orgSlug: "acme", workspaceSlug: "core" });
    expect(calls).toEqual(["assertOrgMember", "assertWorkspaceMember", "invoke"]);
  });

  it("lets a membership miss propagate instead of catching it into an error string", async () => {
    // assertWorkspaceMember signals a non-member by throwing notFound(). If the
    // guards were inside the try, this would come back as `{ ok: false }` and
    // the screen would render a message where Next meant to render a 404.
    const notFound = new Error("NEXT_HTTP_ERROR_FALLBACK;404");
    mockAssertWorkspaceMember.mockImplementation(() => {
      throw notFound;
    });
    await expect(
      listFleetAction({ orgSlug: "acme", workspaceSlug: "core" }),
    ).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("lets the sign-in redirect propagate too", async () => {
    mockGetSession.mockImplementation(() => {
      throw new Error("NEXT_REDIRECT");
    });
    await expect(
      listFleetAction({ orgSlug: "acme", workspaceSlug: "core" }),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(mockAssertOrgMember).not.toHaveBeenCalled();
  });

  it("returns the hosts and the cursor on the happy path", async () => {
    const result = await listFleetAction({
      orgSlug: "acme",
      workspaceSlug: "core",
    });
    expect(result).toEqual({ ok: true, hosts: [HOST], nextCursor: null });
    expect(mockInvoke).toHaveBeenCalledWith(
      "list_tacho_hosts",
      expect.objectContaining({ limit: 50 }),
      expect.objectContaining({ orgId: ORG.id, workspaceId: WS.id }),
      // list_tacho_hosts declares surfaces ["api", "mcp"]; "app" is not one of
      // them, so the call has to present itself as the api surface or the
      // kernel refuses it with surface_denied.
      { surface: "api" },
    );
  });

  it("passes the status filter and the cursor through only when given", async () => {
    await listFleetAction({ orgSlug: "acme", workspaceSlug: "core" });
    expect(mockInvoke.mock.calls[0]?.[1]).toEqual({ limit: 50 });
    await listFleetAction({
      orgSlug: "acme",
      workspaceSlug: "core",
      status: "active",
      cursor: "c1",
    });
    expect(mockInvoke.mock.calls[1]?.[1]).toEqual({
      limit: 50,
      status: "active",
      cursor: "c1",
    });
  });

  it("turns a capability failure into an error result, which is what the try is for", async () => {
    mockInvoke.mockImplementation((): unknown => {
      throw new Error("tenant scope missing");
    });
    expect(
      await listFleetAction({ orgSlug: "acme", workspaceSlug: "core" }),
    ).toEqual({ ok: false, error: "tenant scope missing" });
  });
});

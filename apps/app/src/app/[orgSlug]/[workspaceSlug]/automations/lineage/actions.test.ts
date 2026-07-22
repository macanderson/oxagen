/**
 * actions.test.ts — unit tests for Automations → Lineage's server actions.
 *
 * Covers, per action: happy path (exact capability `name`, input, and
 * `{ surface }` passed to invoke(), plus the mapped `{ ok: true, ... }`
 * result), the workspace-member denial path (invoke never called) — using
 * EACH action's own allowed-role list, since query_lineage allows Viewer and
 * list_subagent_fanouts does not — and the invoke-throws path
 * (`{ ok: false, error }`).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetSession,
  mockResolveOrg,
  mockResolveWorkspace,
  mockAssertOrgMember,
  mockRunInTenantScope,
  mockWithTenantDb,
  mockInvoke,
  dbState,
} = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockResolveOrg: vi.fn(),
  mockResolveWorkspace: vi.fn(),
  mockAssertOrgMember: vi.fn(),
  mockRunInTenantScope: vi.fn((_scope: unknown, fn: () => unknown) => fn()),
  mockWithTenantDb: vi.fn(),
  mockInvoke: vi.fn(),
  dbState: { role: "owner" as string },
}));

vi.mock("@/lib/session", () => ({ getSessionOrRedirect: mockGetSession }));
vi.mock("@/lib/resolve-org", () => ({
  resolveOrg: mockResolveOrg,
  resolveWorkspace: mockResolveWorkspace,
  assertOrgMember: mockAssertOrgMember,
}));
vi.mock("@oxagen/tenancy", () => ({ runInTenantScope: mockRunInTenantScope }));
vi.mock("@oxagen/oxagen", () => ({ invoke: mockInvoke }));
vi.mock("drizzle-orm", () => ({ and: vi.fn(), eq: vi.fn() }));
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/handlers/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("@oxagen/database", () => ({
  withTenantDb: mockWithTenantDb,
  schema: { workspaceUsers: { role: {}, workspaceId: {}, userId: {} } },
}));

import { queryLineageAction, listRecentFanoutsAction } from "./actions";

const BASE = { orgSlug: "acme", workspaceSlug: "core" };

beforeEach(() => {
  vi.clearAllMocks();
  dbState.role = "owner";
  mockGetSession.mockResolvedValue({ user: { id: "user-1" } });
  mockResolveOrg.mockResolvedValue({ id: "org-1" });
  mockResolveWorkspace.mockResolvedValue({ id: "ws-1" });
  mockAssertOrgMember.mockResolvedValue(undefined);
  mockRunInTenantScope.mockImplementation(
    (_scope: unknown, fn: () => unknown) => fn(),
  );
  mockWithTenantDb.mockImplementation(async () => [{ role: dbState.role }]);
});

const SAMPLE_LINEAGE_OUTPUT = {
  dispatchId: "sfo_abc123",
  rootStatus: "completed" as const,
  totalChildren: 1,
  completedChildren: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:05:00.000Z",
  nodes: [],
  nodeCount: 0,
  truncated: false,
  maxDepthReached: false,
};

describe("queryLineageAction", () => {
  it("invokes query_lineage with { surface: agent } and maps the result", async () => {
    mockInvoke.mockResolvedValue(SAMPLE_LINEAGE_OUTPUT);
    const res = await queryLineageAction({ ...BASE, dispatchId: "sfo_abc123" });
    expect(res).toEqual({ ok: true, data: SAMPLE_LINEAGE_OUTPUT });
    const [cap, input, , opts] = mockInvoke.mock.calls[0] ?? [];
    expect(cap).toBe("query_lineage");
    expect(input).toEqual({ dispatchId: "sfo_abc123" });
    expect(opts).toEqual({ surface: "agent" });
  });

  it("passes maxDepth/maxNodes through to invoke when provided", async () => {
    mockInvoke.mockResolvedValue(SAMPLE_LINEAGE_OUTPUT);
    await queryLineageAction({
      ...BASE,
      dispatchId: "sfo_abc123",
      maxDepth: 8,
      maxNodes: 400,
    });
    const [, input] = mockInvoke.mock.calls[0] ?? [];
    expect(input).toEqual({
      dispatchId: "sfo_abc123",
      maxDepth: 8,
      maxNodes: 400,
    });
  });

  it("allows a workspace Viewer (query_lineage's own defaultRoles includes Viewer)", async () => {
    dbState.role = "viewer";
    mockInvoke.mockResolvedValue(SAMPLE_LINEAGE_OUTPUT);
    const res = await queryLineageAction({ ...BASE, dispatchId: "sfo_abc123" });
    expect(res.ok).toBe(true);
    expect(mockInvoke).toHaveBeenCalled();
  });

  it("denies a non-workspace-member (unknown role) without calling invoke", async () => {
    dbState.role = "";
    const res = await queryLineageAction({ ...BASE, dispatchId: "sfo_abc123" });
    expect(res).toMatchObject({
      ok: false,
      error: expect.stringMatching(/you must be a workspace member/i),
    });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("returns ok:false with the error message when invoke throws", async () => {
    mockInvoke.mockRejectedValue(new Error("fanout not found: sfo_missing"));
    const res = await queryLineageAction({
      ...BASE,
      dispatchId: "sfo_missing",
    });
    expect(res).toEqual({ ok: false, error: "fanout not found: sfo_missing" });
  });

  it("falls back to a generic error message when invoke throws a non-Error", async () => {
    mockInvoke.mockRejectedValue("boom");
    const res = await queryLineageAction({ ...BASE, dispatchId: "sfo_abc123" });
    expect(res).toEqual({
      ok: false,
      error: "Failed to load the dispatch tree.",
    });
  });
});

describe("listRecentFanoutsAction", () => {
  const SAMPLE_FANOUTS = [
    {
      fanoutId: "sfo_abc123",
      parentMessageId: "msg_1",
      status: "completed" as const,
      totalChildren: 3,
      completedChildren: 3,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:05:00.000Z",
    },
  ];

  it("invokes list_subagent_fanouts with { surface: agent } and maps the result", async () => {
    mockInvoke.mockResolvedValue({ fanouts: SAMPLE_FANOUTS });
    const res = await listRecentFanoutsAction(BASE);
    expect(res).toEqual({ ok: true, fanouts: SAMPLE_FANOUTS });
    const [cap, input, , opts] = mockInvoke.mock.calls[0] ?? [];
    expect(cap).toBe("list_subagent_fanouts");
    expect(input).toEqual({});
    expect(opts).toEqual({ surface: "agent" });
  });

  it("passes limit through when provided", async () => {
    mockInvoke.mockResolvedValue({ fanouts: [] });
    await listRecentFanoutsAction({ ...BASE, limit: 10 });
    const [, input] = mockInvoke.mock.calls[0] ?? [];
    expect(input).toEqual({ limit: 10 });
  });

  it("denies a workspace Viewer — list_subagent_fanouts's own defaultRoles excludes Viewer", async () => {
    dbState.role = "viewer";
    const res = await listRecentFanoutsAction(BASE);
    expect(res).toMatchObject({
      ok: false,
      error: expect.stringMatching(/you must be a workspace member/i),
    });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("allows a workspace Member", async () => {
    dbState.role = "member";
    mockInvoke.mockResolvedValue({ fanouts: [] });
    const res = await listRecentFanoutsAction(BASE);
    expect(res.ok).toBe(true);
  });

  it("returns ok:false when invoke throws", async () => {
    mockInvoke.mockRejectedValue(new Error("db unavailable"));
    const res = await listRecentFanoutsAction(BASE);
    expect(res).toEqual({ ok: false, error: "db unavailable" });
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetSession,
  mockResolveOrg,
  mockResolveWorkspace,
  mockAssertOrgMember,
  mockRunInTenantScope,
  mockInvoke,
} = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockResolveOrg: vi.fn(),
  mockResolveWorkspace: vi.fn(),
  mockAssertOrgMember: vi.fn(),
  mockRunInTenantScope: vi.fn((_scope: unknown, fn: () => unknown) => fn()),
  mockInvoke: vi.fn(),
}));

vi.mock("@oxagen/tenancy", () => ({ runInTenantScope: mockRunInTenantScope }));
vi.mock("@oxagen/oxagen", () => ({ invoke: mockInvoke }));
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/agent/register", () => ({}));
vi.mock("@/lib/session", () => ({ getSessionOrRedirect: mockGetSession }));
vi.mock("@/lib/resolve-org", () => ({
  resolveOrg: mockResolveOrg,
  getOrgRole: vi.fn().mockResolvedValue("owner"),
  resolveWorkspace: mockResolveWorkspace,
  assertOrgMember: mockAssertOrgMember,
}));

import { listFanoutsAction, getFanoutAction } from "./fanout-actions";

const SCOPE = { orgSlug: "acme", workspaceSlug: "prod" };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSession.mockResolvedValue({ user: { id: "user-1" } });
  mockResolveOrg.mockResolvedValue({ id: "org-1" });
  mockResolveWorkspace.mockResolvedValue({ id: "ws-1" });
  mockAssertOrgMember.mockResolvedValue(undefined);
  mockRunInTenantScope.mockImplementation((_scope: unknown, fn: () => unknown) => fn());
});

describe("listFanoutsAction", () => {
  it("resolves scope, asserts membership, and invokes the list capability", async () => {
    mockInvoke.mockResolvedValue({ fanouts: [] });
    const out = await listFanoutsAction(SCOPE);

    expect(mockResolveOrg).toHaveBeenCalledWith("acme");
    expect(mockResolveWorkspace).toHaveBeenCalledWith("org-1", "prod");
    expect(mockAssertOrgMember).toHaveBeenCalledWith("org-1", "user-1");
    expect(mockInvoke).toHaveBeenCalledWith(
      "agent.subagent.fanout.list",
      { limit: 50 },
      expect.objectContaining({ orgId: "org-1", workspaceId: "ws-1", surface: "app" }),
      { surface: "agent" },
    );
    expect(out).toEqual({ fanouts: [] });
  });
});

describe("getFanoutAction", () => {
  it("invokes the get capability with the fanoutId", async () => {
    const result = { fanoutId: "fan_1", runs: [] };
    mockInvoke.mockResolvedValue(result);
    const out = await getFanoutAction(SCOPE, "fan_1");

    expect(mockInvoke).toHaveBeenCalledWith(
      "agent.subagent.fanout.get",
      { fanoutId: "fan_1" },
      expect.objectContaining({ orgId: "org-1", workspaceId: "ws-1" }),
      { surface: "agent" },
    );
    expect(out).toEqual(result);
  });

  it("propagates a not-found error from invoke", async () => {
    mockInvoke.mockRejectedValue(new Error("Fanout fan_x not found"));
    await expect(getFanoutAction(SCOPE, "fan_x")).rejects.toThrow("not found");
  });
});

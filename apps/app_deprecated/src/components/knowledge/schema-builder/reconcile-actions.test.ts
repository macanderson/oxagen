/**
 * reconcile-actions.test.ts — surface regression tests.
 *
 * Bug: schemaReconcileDispatchAction / schemaReconcileStatusAction invoked their
 * capabilities over the *contract* surface "agent", but schema.reconcile.dispatch
 * and schema.reconcile.status only expose ["api","mcp","cli"]. The kernel matches
 * the contract surface, so the call 500'd with:
 *   CapabilityError: Capability "schema.reconcile.dispatch" is not exposed on the
 *   "agent" surface
 * which broke the PinChangeDialog "Run reconciliation" flow.
 *
 * The actions must invoke over a surface the contract actually exposes ("api"),
 * mirroring the in-app proxy route (AGENT_SURFACE_CAPABILITIES = {schema.delete}).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockInvoke,
  mockGetSession,
  mockResolveOrg,
  mockResolveWorkspace,
  mockAssertWorkspaceMember,
} = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockGetSession: vi.fn(),
  mockResolveOrg: vi.fn(),
  mockResolveWorkspace: vi.fn(),
  mockAssertWorkspaceMember: vi.fn(),
}));

vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mockInvoke }));
vi.mock("@/lib/session", () => ({ getSessionOrRedirect: mockGetSession }));
vi.mock("@/lib/resolve-org", () => ({
  resolveOrg: mockResolveOrg,
  resolveWorkspace: mockResolveWorkspace,
  assertWorkspaceMember: mockAssertWorkspaceMember,
}));

import {
  schemaReconcileDispatchAction,
  schemaReconcileStatusAction,
} from "./reconcile-actions";

const ORG = { id: "org-1", slug: "acme" };
const WORKSPACE = { id: "ws-1", slug: "default" };
const SESSION = { user: { id: "user-1" } };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSession.mockResolvedValue(SESSION);
  mockResolveOrg.mockResolvedValue(ORG);
  mockResolveWorkspace.mockResolvedValue(WORKSPACE);
  mockAssertWorkspaceMember.mockResolvedValue(undefined);
});

describe("schemaReconcileDispatchAction", () => {
  it("invokes schema.reconcile.dispatch over the 'api' surface (NOT 'agent')", async () => {
    mockInvoke.mockResolvedValue({ executionId: "aex_1" });

    const result = await schemaReconcileDispatchAction({
      orgSlug: "acme",
      workspaceSlug: "default",
      versionId: "scv_1",
      prune: true,
    });

    expect(result).toEqual({ executionId: "aex_1" });
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    const [capability, input, ctx, opts] = mockInvoke.mock.calls[0]!;
    expect(capability).toBe("dispatch_schema_reconcile");
    expect(input).toEqual({ versionId: "scv_1", prune: true });
    expect(ctx).toEqual(
      expect.objectContaining({
        orgId: "org-1",
        workspaceId: "ws-1",
        userId: "user-1",
      }),
    );
    // The crux of the fix: contract surface must be one the contract exposes.
    expect(opts).toEqual({ surface: "api" });
    expect((opts as { surface: string }).surface).not.toBe("agent");
  });

  it("asserts workspace membership before invoking (IDOR guard)", async () => {
    mockInvoke.mockResolvedValue({ executionId: "aex_1" });
    await schemaReconcileDispatchAction({
      orgSlug: "acme",
      workspaceSlug: "default",
      versionId: "scv_1",
      prune: false,
    });
    expect(mockAssertWorkspaceMember).toHaveBeenCalledWith("ws-1", "user-1");
  });

  it("denies a non-member and never reaches invoke", async () => {
    mockAssertWorkspaceMember.mockRejectedValue(new Error("NEXT_NOT_FOUND"));
    await expect(
      schemaReconcileDispatchAction({
        orgSlug: "acme",
        workspaceSlug: "default",
        versionId: "scv_1",
        prune: false,
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

describe("schemaReconcileStatusAction", () => {
  it("invokes schema.reconcile.status over the 'api' surface (NOT 'agent')", async () => {
    mockInvoke.mockResolvedValue({
      status: "running",
      totalNodes: 28,
      processedNodes: 0,
      updatedNodes: 0,
      totalRelationships: 0,
      processedRelationships: 0,
      updatedRelationships: 0,
      prunedNodes: 0,
      prunedRelationships: 0,
    });

    const result = await schemaReconcileStatusAction(
      "acme",
      "default",
      "aex_1",
    );

    expect(result.status).toBe("running");
    expect(result.totalNodes).toBe(28);
    const [capability, input, , opts] = mockInvoke.mock.calls[0]!;
    expect(capability).toBe("get_reconcile_status");
    expect(input).toEqual({ executionId: "aex_1" });
    expect(opts).toEqual({ surface: "api" });
    expect((opts as { surface: string }).surface).not.toBe("agent");
  });
});

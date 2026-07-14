/**
 * actions.test.ts — unit tests for the node-detail admin server actions:
 * deleteNodeAction, addNodeLabelAction, removeNodeLabelAction,
 * upsertEdgeAction, deleteEdgeAction.
 *
 * Covers: input validation guards, the org-admin gate (assertOrgAdmin called
 * before any invoke()), invoke() argument shape + surface override, success
 * mapping, revalidatePath calls, and invoke-throws error mapping.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetSession,
  mockResolveOrg,
  mockResolveWorkspace,
  mockAssertOrgMember,
  mockAssertOrgAdmin,
  mockRunInTenantScope,
  mockInvoke,
  mockRevalidatePath,
} = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockResolveOrg: vi.fn(),
  mockResolveWorkspace: vi.fn(),
  mockAssertOrgMember: vi.fn(),
  mockAssertOrgAdmin: vi.fn(),
  mockRunInTenantScope: vi.fn((_scope: unknown, fn: () => unknown) => fn()),
  mockInvoke: vi.fn(),
  mockRevalidatePath: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionOrRedirect: mockGetSession }));
vi.mock("@/lib/resolve-org", () => ({
  resolveOrg: mockResolveOrg,
  resolveWorkspace: mockResolveWorkspace,
  assertOrgMember: mockAssertOrgMember,
  assertOrgAdmin: mockAssertOrgAdmin,
}));
vi.mock("@oxagen/tenancy", () => ({ runInTenantScope: mockRunInTenantScope }));
vi.mock("@oxagen/oxagen", () => ({ invoke: mockInvoke }));
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/handlers/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  deleteNodeAction,
  addNodeLabelAction,
  removeNodeLabelAction,
  upsertEdgeAction,
  deleteEdgeAction,
} from "./actions";

const BASE = { orgSlug: "acme", workspaceSlug: "main" };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSession.mockResolvedValue({ user: { id: "user-1" } });
  mockResolveOrg.mockResolvedValue({ id: "org-1" });
  mockResolveWorkspace.mockResolvedValue({ id: "ws-1" });
  mockAssertOrgMember.mockResolvedValue(undefined);
  mockAssertOrgAdmin.mockResolvedValue(undefined);
  mockRunInTenantScope.mockImplementation((_scope: unknown, fn: () => unknown) => fn());
});

describe("deleteNodeAction", () => {
  it("asserts org-admin before invoking, in order", async () => {
    mockInvoke.mockResolvedValue({ deleted: true });
    await deleteNodeAction({ ...BASE, nodeId: "kn_1" });
    expect(mockAssertOrgMember).toHaveBeenCalledWith("org-1", "user-1");
    expect(mockAssertOrgAdmin).toHaveBeenCalledWith("org-1", "user-1");
    expect(mockAssertOrgAdmin.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockAssertOrgMember.mock.invocationCallOrder[0] ?? 0,
    );
    expect(mockInvoke.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockAssertOrgAdmin.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("propagates a rejection from assertOrgAdmin (e.g. Next notFound()) without invoking", async () => {
    mockAssertOrgAdmin.mockRejectedValue(new Error("NEXT_NOT_FOUND"));
    await expect(deleteNodeAction({ ...BASE, nodeId: "kn_1" })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("invokes delete_node with the agent surface override and revalidates both paths", async () => {
    mockInvoke.mockResolvedValue({ deleted: true });
    const res = await deleteNodeAction({ ...BASE, nodeId: "kn_1" });
    expect(res).toEqual({ ok: true, deleted: true });

    const [cap, input, , opts] = mockInvoke.mock.calls[0] ?? [];
    expect(cap).toBe("delete_node");
    expect(input).toEqual({ nodeId: "kn_1" });
    expect(opts).toEqual({ surface: "agent" });

    expect(mockRevalidatePath).toHaveBeenCalledWith("/acme/main/knowledge/graph/kn_1");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/acme/main/knowledge/graph");
  });

  it("returns ok:false with the error message when invoke throws", async () => {
    mockInvoke.mockRejectedValue(new Error("neo4j down"));
    const res = await deleteNodeAction({ ...BASE, nodeId: "kn_1" });
    expect(res).toEqual({ ok: false, error: "neo4j down" });
  });
});

describe("addNodeLabelAction", () => {
  it("rejects when no non-blank labels are supplied", async () => {
    const res = await addNodeLabelAction({ ...BASE, nodeId: "kn_1", labels: ["  "] });
    expect(res).toEqual({ ok: false, error: expect.stringContaining("at least one label") });
    expect(mockResolveOrg).not.toHaveBeenCalled();
  });

  it("trims labels, invokes add_node_label, and returns the updated set", async () => {
    mockInvoke.mockResolvedValue({ nodeId: "kn_1", labels: ["Billing"], added: ["Billing"] });
    const res = await addNodeLabelAction({ ...BASE, nodeId: "kn_1", labels: [" Billing "] });
    expect(res).toEqual({ ok: true, labels: ["Billing"], added: ["Billing"] });

    const [cap, input, , opts] = mockInvoke.mock.calls[0] ?? [];
    expect(cap).toBe("add_node_label");
    expect(input).toEqual({ nodeId: "kn_1", labels: ["Billing"] });
    expect(opts).toEqual({ surface: "agent" });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/acme/main/knowledge/graph/kn_1");
  });

  it("returns ok:false when invoke throws", async () => {
    mockInvoke.mockRejectedValue(new Error("invalid label"));
    const res = await addNodeLabelAction({ ...BASE, nodeId: "kn_1", labels: ["Billing"] });
    expect(res).toEqual({ ok: false, error: "invalid label" });
  });
});

describe("removeNodeLabelAction", () => {
  it("rejects when no non-blank labels are supplied", async () => {
    const res = await removeNodeLabelAction({ ...BASE, nodeId: "kn_1", labels: [] });
    expect(res).toEqual({ ok: false, error: expect.stringContaining("No label") });
    expect(mockResolveOrg).not.toHaveBeenCalled();
  });

  it("invokes remove_node_label and returns the updated set", async () => {
    mockInvoke.mockResolvedValue({ nodeId: "kn_1", labels: [], removed: ["Billing"] });
    const res = await removeNodeLabelAction({ ...BASE, nodeId: "kn_1", labels: ["Billing"] });
    expect(res).toEqual({ ok: true, labels: [], removed: ["Billing"] });
    expect(mockInvoke.mock.calls[0]?.[0]).toBe("remove_node_label");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/acme/main/knowledge/graph/kn_1");
  });

  it("returns ok:false when invoke throws", async () => {
    mockInvoke.mockRejectedValue(new Error("node not found"));
    const res = await removeNodeLabelAction({ ...BASE, nodeId: "kn_1", labels: ["Billing"] });
    expect(res).toEqual({ ok: false, error: "node not found" });
  });
});

describe("upsertEdgeAction", () => {
  it("rejects when toNodeId is blank", async () => {
    const res = await upsertEdgeAction({
      ...BASE,
      fromNodeId: "kn_1",
      toNodeId: "  ",
      relationshipType: "RELATES_TO",
    });
    expect(res).toEqual({ ok: false, error: expect.stringContaining("required") });
    expect(mockResolveOrg).not.toHaveBeenCalled();
  });

  it("rejects when relationshipType is blank", async () => {
    const res = await upsertEdgeAction({
      ...BASE,
      fromNodeId: "kn_1",
      toNodeId: "kn_2",
      relationshipType: "",
    });
    expect(res).toEqual({ ok: false, error: expect.stringContaining("required") });
  });

  it("invokes upsert_edge with trimmed fields and returns the result", async () => {
    mockInvoke.mockResolvedValue({ edgeId: "kn_1:RELATES_TO:kn_2", created: true, superseded: 0 });
    const res = await upsertEdgeAction({
      ...BASE,
      fromNodeId: "kn_1",
      toNodeId: " kn_2 ",
      relationshipType: " RELATES_TO ",
    });
    expect(res).toEqual({ ok: true, edgeId: "kn_1:RELATES_TO:kn_2", created: true, superseded: 0 });

    const [cap, input, , opts] = mockInvoke.mock.calls[0] ?? [];
    expect(cap).toBe("upsert_edge");
    expect(input).toEqual({ fromNodeId: "kn_1", toNodeId: "kn_2", relationshipType: "RELATES_TO" });
    expect(opts).toEqual({ surface: "agent" });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/acme/main/knowledge/graph/kn_1");
  });

  it("returns ok:false when invoke throws", async () => {
    mockInvoke.mockRejectedValue(new Error("invalid relationship type"));
    const res = await upsertEdgeAction({
      ...BASE,
      fromNodeId: "kn_1",
      toNodeId: "kn_2",
      relationshipType: "RELATES_TO",
    });
    expect(res).toEqual({ ok: false, error: "invalid relationship type" });
  });
});

describe("deleteEdgeAction", () => {
  it("rejects when toNodeId or edgeType is blank", async () => {
    const res = await deleteEdgeAction({
      ...BASE,
      fromNodeId: "kn_1",
      toNodeId: "kn_2",
      edgeType: "",
    });
    expect(res).toEqual({ ok: false, error: expect.stringContaining("required") });
    expect(mockResolveOrg).not.toHaveBeenCalled();
  });

  it("invokes delete_edge and returns the result", async () => {
    mockInvoke.mockResolvedValue({ deleted: true });
    const res = await deleteEdgeAction({
      ...BASE,
      fromNodeId: "kn_1",
      toNodeId: "kn_2",
      edgeType: "RELATES_TO",
    });
    expect(res).toEqual({ ok: true, deleted: true });

    const [cap, input, , opts] = mockInvoke.mock.calls[0] ?? [];
    expect(cap).toBe("delete_edge");
    expect(input).toEqual({ fromNodeId: "kn_1", toNodeId: "kn_2", edgeType: "RELATES_TO" });
    expect(opts).toEqual({ surface: "agent" });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/acme/main/knowledge/graph/kn_1");
  });

  it("returns ok:false when invoke throws", async () => {
    mockInvoke.mockRejectedValue(new Error("edge not found"));
    const res = await deleteEdgeAction({
      ...BASE,
      fromNodeId: "kn_1",
      toNodeId: "kn_2",
      edgeType: "RELATES_TO",
    });
    expect(res).toEqual({ ok: false, error: "edge not found" });
  });
});

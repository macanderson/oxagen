// The Cost centers writes through the real kernel seam (INV-19): the viewer
// resolution and the kernel's invoke() are the only fakes, so each case shows
// what reaches the capability and what the person gets back.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, requireViewer } = vi.hoisted(() => ({
  invoke: vi.fn<typeof import("@oxagen/oxagen").invoke>(),
  requireViewer: vi.fn(),
}));
vi.mock("@oxagen/oxagen", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/oxagen")>()),
  invoke,
}));
vi.mock("@oxagen/telemetry", () => ({ captureError: vi.fn() }));
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/agent/register", () => ({}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));
vi.mock("@/server/viewer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/viewer")>()),
  requireViewer,
}));

const kernel =
  await vi.importActual<typeof import("@oxagen/oxagen")>("@oxagen/oxagen");
const { OrgCtx, WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { createCostCenter, deleteCostCenter, setWorkspaceCostCenter } =
  await import("./cost-center-actions");

const org = {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "billing" as const,
};
const orgCtx = unsafeMint(OrgCtx, org);
const wsCtx = unsafeMint(WsCtx, {
  ...org,
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "member",
});

const center = {
  id: "ccn_0a1b2c3d4e5f6g7h8j9k0m",
  label: "ENG-1001",
  description: null,
  agents: 0,
  workspaces: 0,
  createdAt: "2026-09-22T10:00:00.000Z",
};

beforeEach(() => {
  invoke.mockReset();
  requireViewer.mockReset().mockResolvedValue(orgCtx);
});

describe("createCostCenter", () => {
  it("adds the label for the organization viewer, leaving out a blank description", async () => {
    invoke.mockResolvedValue({ costCenter: center });
    expect(
      await createCostCenter("acme", { label: " ENG-1001 ", description: " " }),
    ).toEqual({ ok: true, value: { label: "ENG-1001" } });
    expect(requireViewer).toHaveBeenCalledWith("acme");
    expect(invoke).toHaveBeenCalledWith(
      "create_cost_center",
      { label: "ENG-1001" },
      expect.objectContaining({ orgId: org.orgId }),
    );
  });

  it("passes a description the person typed", async () => {
    invoke.mockResolvedValue({ costCenter: center });
    await createCostCenter("acme", {
      label: "ENG-1001",
      description: "Platform",
    });
    expect(invoke).toHaveBeenCalledWith(
      "create_cost_center",
      { label: "ENG-1001", description: "Platform" },
      expect.anything(),
    );
  });

  it("refuses a malformed label before the kernel runs (negative)", async () => {
    const result = await createCostCenter("acme", {
      label: "~none",
      description: "",
    });
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("answers a live label as a conflict (negative)", async () => {
    invoke.mockRejectedValue(
      new kernel.HandlerError({
        code: "conflict",
        reason: "cost_center_exists",
      }),
    );
    expect(
      await createCostCenter("acme", { label: "ENG-1001", description: "" }),
    ).toMatchObject({ ok: false, reason: "conflict" });
  });
});

describe("deleteCostCenter", () => {
  it("deletes the label and reports it", async () => {
    invoke.mockResolvedValue({
      label: "ENG-1001",
      deletedAt: "2026-09-22T10:00:00.000Z",
    });
    expect(await deleteCostCenter("acme", "ENG-1001")).toEqual({
      ok: true,
      value: { label: "ENG-1001" },
    });
  });

  it("passes a refusal through (negative)", async () => {
    invoke.mockRejectedValue(
      new kernel.CapabilityError("delete_cost_center", "authz_denied", "no"),
    );
    expect(await deleteCostCenter("acme", "ENG-1001")).toMatchObject({
      ok: false,
      reason: "denied",
    });
  });
});

describe("setWorkspaceCostCenter", () => {
  beforeEach(() => {
    requireViewer.mockResolvedValue(wsCtx);
  });

  it("charges the workspace it names to the label", async () => {
    invoke.mockResolvedValue({
      target: "workspace",
      id: "wrk_1",
      costCenter: "ENG-1001",
    });
    expect(
      await setWorkspaceCostCenter("acme", "core-platform", "ENG-1001"),
    ).toEqual({ ok: true, value: { costCenter: "ENG-1001" } });
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(invoke).toHaveBeenCalledWith(
      "set_cost_center",
      { target: "workspace", costCenter: "ENG-1001" },
      expect.objectContaining({ workspaceId: wsCtx.workspaceId }),
    );
  });

  it("clears the label when None is picked", async () => {
    invoke.mockResolvedValue({
      target: "workspace",
      id: "wrk_1",
      costCenter: null,
    });
    expect(await setWorkspaceCostCenter("acme", "core-platform", "")).toEqual({
      ok: true,
      value: { costCenter: null },
    });
    expect(invoke).toHaveBeenCalledWith(
      "set_cost_center",
      { target: "workspace", costCenter: null },
      expect.anything(),
    );
  });

  it("answers an unknown label as not found (negative)", async () => {
    invoke.mockRejectedValue(
      new kernel.HandlerError({
        code: "not_found",
        reason: "cost_center_not_found",
      }),
    );
    expect(
      await setWorkspaceCostCenter("acme", "core-platform", "GONE-1"),
    ).toMatchObject({ ok: false, reason: "not_found" });
  });
});

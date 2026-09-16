// The approvals port: list_approvals through the kernel seam for the workspace
// (Fleet) or one run (Run), mapped into approval items, with a refusal passed
// through and an unmappable record reported once.
import { agentApprovalList } from "@oxagen/oxagen/contracts/agent.approval.list";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { kernelRead, captureError } = vi.hoisted(() => ({
  kernelRead: vi.fn(),
  captureError: vi.fn(),
}));
vi.mock("@/server/kernel", () => ({ kernelRead }));
vi.mock("@oxagen/telemetry", () => ({ captureError }));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { readError, readOk } = await import("@/data/read");
const { approvals } = await import("./approvals");

const ctx = unsafeMint(WsCtx, {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "member",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
});

const item = {
  id: "apr_q8t1",
  runId: null,
  tool: "create_release",
  requester: null,
  mandateId: null,
  createdAt: "2026-09-15T08:57:30.000Z",
  expiresAt: "2026-09-15T09:07:30.000Z",
  chain: { agentKey: null, rule: null },
};

beforeEach(() => {
  kernelRead.mockReset();
  captureError.mockReset();
});

describe("approvals.pending", () => {
  it("reads the workspace's pending approvals for Fleet and maps them", async () => {
    kernelRead.mockResolvedValue(readOk({ items: [item], nextCursor: null }));
    expect(await approvals.pending(ctx, { runId: null })).toEqual(
      readOk([
        {
          id: "apr_q8t1",
          runId: null,
          tool: "create_release",
          agentKey: null,
          requester: null,
          mandateId: null,
          createdAt: "2026-09-15T08:57:30.000Z",
          expiresAt: "2026-09-15T09:07:30.000Z",
        },
      ]),
    );
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: agentApprovalList,
      input: { limit: 100 },
      page: "fleet",
    });
    expect(captureError).not.toHaveBeenCalled();
  });

  it("narrows to one run and answers a refusal with the Run page's failure", async () => {
    kernelRead.mockResolvedValue(readOk({ items: [], nextCursor: null }));
    await approvals.pending(ctx, { runId: "arun_7k2m9q" });
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: agentApprovalList,
      input: { runId: "arun_7k2m9q", limit: 100 },
      page: "run",
    });
  });

  it("passes a failed read through (negative)", async () => {
    const down = readError("run_index_unavailable", 503);
    kernelRead.mockResolvedValue(down);
    expect(await approvals.pending(ctx, { runId: null })).toEqual(down);
  });

  it("answers record_unmappable and reports once for a record the view refuses (negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk({ items: [{ ...item, tool: "" }], nextCursor: null }),
    );
    expect(await approvals.pending(ctx, { runId: null })).toEqual(
      readError("record_unmappable", 502),
    );
    expect(captureError).toHaveBeenCalledOnce();
  });
});

// The approvals port: list_approvals through the kernel seam for the workspace
// (Fleet) or one run (Run), mapped into approval items, with a refusal passed
// through and an unmappable record reported once.
import { agentApprovalList } from "@oxagen/oxagen/contracts/agent.approval.list";
import { agentApprovalListResolved } from "@oxagen/oxagen/contracts/agent.approval.list_resolved";
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
  wsRole: "member",
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

describe("approvals.resolved (#3153)", () => {
  const resolvedItem = {
    id: "apr_q8t1",
    runId: "arun_7k2m9q",
    tool: "stripe__create_payment",
    requester: null,
    createdAt: "2026-09-18T10:00:00.000Z",
    expiresAt: "2026-09-18T10:05:00.000Z",
    resolvedAt: "2026-09-18T10:00:01.000Z",
    resolution: "approved" as const,
    resolvedBy: "policy:small-vendor-payments",
    autoRuleId: "small-vendor-payments",
    autoEligibility: {
      ruleId: "small-vendor-payments",
      ok: true,
      reasons: [],
      floor: false,
    },
    mandateId: null,
    chain: { agentKey: null, rule: null },
  };

  it("reads a run's resolved approvals and maps the rule that released one with no person", async () => {
    kernelRead.mockResolvedValue(
      readOk({ items: [resolvedItem], nextCursor: null }),
    );
    expect(await approvals.resolved(ctx, { runId: "arun_7k2m9q" })).toEqual(
      readOk([
        {
          id: "apr_q8t1",
          runId: "arun_7k2m9q",
          tool: "stripe__create_payment",
          requester: null,
          createdAt: "2026-09-18T10:00:00.000Z",
          expiresAt: "2026-09-18T10:05:00.000Z",
          resolvedAt: "2026-09-18T10:00:01.000Z",
          resolution: "approved",
          resolvedBy: "policy:small-vendor-payments",
          autoRuleRef: "small-vendor-payments",
        },
      ]),
    );
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: agentApprovalListResolved,
      input: { runId: "arun_7k2m9q", limit: 100, cursor: undefined },
      page: "run",
    });
    expect(captureError).not.toHaveBeenCalled();
  });

  // #3153 P2: a run with more than one page of resolved approvals must not
  // silently read as only the newest page.
  it("walks every page the contract hands back and combines them into one list", async () => {
    kernelRead
      .mockResolvedValueOnce(
        readOk({ items: [resolvedItem], nextCursor: "c2" }),
      )
      .mockResolvedValueOnce(
        readOk({
          items: [{ ...resolvedItem, id: "apr_next" }],
          nextCursor: null,
        }),
      );
    const out = await approvals.resolved(ctx, { runId: "arun_7k2m9q" });
    expect(out.ok && out.value.map((i) => i.id)).toEqual([
      "apr_q8t1",
      "apr_next",
    ]);
    expect(kernelRead).toHaveBeenCalledTimes(2);
    expect(kernelRead).toHaveBeenNthCalledWith(2, ctx, {
      contract: agentApprovalListResolved,
      input: { runId: "arun_7k2m9q", limit: 100, cursor: "c2" },
      page: "run",
    });
  });

  it("stops at MAX_RESOLVED_PAGES rather than paging a run's ledger forever (negative)", async () => {
    kernelRead.mockImplementation(() =>
      Promise.resolve(readOk({ items: [resolvedItem], nextCursor: "more" })),
    );
    const out = await approvals.resolved(ctx, { runId: "arun_7k2m9q" });
    expect(kernelRead).toHaveBeenCalledTimes(10);
    expect(out.ok && out.value).toHaveLength(10);
  });

  it("passes a failed read through, without paging further (negative)", async () => {
    const down = readError("run_index_unavailable", 503);
    kernelRead.mockResolvedValue(down);
    expect(await approvals.resolved(ctx, { runId: "arun_7k2m9q" })).toEqual(
      down,
    );
    expect(kernelRead).toHaveBeenCalledOnce();
  });

  it("answers record_unmappable and reports once for a record the view refuses (negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk({ items: [{ ...resolvedItem, tool: "" }], nextCursor: null }),
    );
    expect(await approvals.resolved(ctx, { runId: "arun_7k2m9q" })).toEqual(
      readError("record_unmappable", 502),
    );
    expect(captureError).toHaveBeenCalledOnce();
  });
});

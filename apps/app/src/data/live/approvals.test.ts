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
const { approvals, PAGE_SIZE } = await import("./approvals");

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
  autoEligibility: null,
  createdAt: "2026-09-15T08:57:30.000Z",
  expiresAt: "2026-09-15T09:07:30.000Z",
  chain: { agentKey: null, rule: null },
};

beforeEach(() => {
  kernelRead.mockReset();
  captureError.mockReset();
});

describe("approvals.pending", () => {
  it("reads the workspace's pending approvals for Fleet, with both chain hops and the recorded evaluation", async () => {
    const judged = {
      ...item,
      mandateId: "mnd_4f2a9c",
      chain: {
        agentKey: "acme.core.release-bot",
        rule: "mandate:mnd_4f2a9c:human_above:amount",
      },
      autoEligibility: {
        ruleId: "small-vendor-payments",
        ok: false,
        reasons: ["measure_above_ceiling:amount"],
        floor: false,
      },
    };
    kernelRead.mockResolvedValue(
      readOk({ items: [judged], nextCursor: null, total: 1 }),
    );
    expect(await approvals.pending(ctx, { runId: null })).toEqual(
      readOk({
        items: [
          {
            id: "apr_q8t1",
            runId: null,
            tool: "create_release",
            agentKey: "acme.core.release-bot",
            requester: null,
            mandateId: "mnd_4f2a9c",
            rule: "mandate:mnd_4f2a9c:human_above:amount",
            autoEligibility: {
              ruleRef: "small-vendor-payments",
              ok: false,
              reasons: ["measure_above_ceiling:amount"],
              floor: false,
            },
            createdAt: "2026-09-15T08:57:30.000Z",
            expiresAt: "2026-09-15T09:07:30.000Z",
          },
        ],
        total: 1,
        more: false,
      }),
    );
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: agentApprovalList,
      input: { limit: 100 },
      page: "fleet",
    });
    expect(captureError).not.toHaveBeenCalled();
  });

  it("narrows to one run and answers a refusal with the Run page's failure", async () => {
    kernelRead.mockResolvedValue(
      readOk({ items: [], nextCursor: null, total: 0 }),
    );
    await approvals.pending(ctx, { runId: "arun_7k2m9q" });
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: agentApprovalList,
      input: { runId: "arun_7k2m9q", limit: 100 },
      page: "run",
    });
  });

  // #3521: Fleet used to walk up to ten pages in series to count the queue,
  // and mounted a card for every row. The count now comes with the first page.
  it("reads one page for a queue over a hundred, and carries the whole queue's count", async () => {
    const page = Array.from({ length: PAGE_SIZE }, (_, n) => ({
      ...item,
      id: `apr_q${n.toString(36)}`,
    }));
    kernelRead.mockResolvedValue(
      readOk({ items: page, nextCursor: "c2", total: 1_437 }),
    );
    const out = await approvals.pending(ctx, { runId: null });
    expect(kernelRead).toHaveBeenCalledOnce();
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: agentApprovalList,
      input: { limit: PAGE_SIZE },
      page: "fleet",
    });
    expect(out.ok && out.value.items).toHaveLength(PAGE_SIZE);
    expect(out.ok && out.value.total).toBe(1_437);
    expect(out.ok && out.value.more).toBe(true);
  });

  it("reads the last page as the whole queue", async () => {
    kernelRead.mockResolvedValue(
      readOk({ items: [item], nextCursor: null, total: 1 }),
    );
    const out = await approvals.pending(ctx, { runId: null });
    expect(out.ok && out.value.total).toBe(1);
    expect(out.ok && out.value.more).toBe(false);
  });

  // The count and the page are two statements. A call answered between them
  // can leave the count one short of the page, and the panel draws the page.
  it("never counts fewer approvals than the page it drew (negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        items: [item, { ...item, id: "apr_next" }],
        nextCursor: null,
        total: 1,
      }),
    );
    const out = await approvals.pending(ctx, { runId: null });
    expect(out.ok && out.value.total).toBe(2);
    expect(out.ok && out.value.more).toBe(false);
  });

  it("passes a failed read through, without paging further (negative)", async () => {
    const down = readError("run_index_unavailable", 503);
    kernelRead.mockResolvedValue(down);
    expect(await approvals.pending(ctx, { runId: null })).toEqual(down);
    expect(kernelRead).toHaveBeenCalledOnce();
  });

  it("answers record_unmappable and reports once for a record the view refuses (negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk({ items: [{ ...item, tool: "" }], nextCursor: null, total: 1 }),
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
      readOk({
        items: [
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
        ],
        more: false,
      }),
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
    expect(out.ok && out.value.items.map((i) => i.id)).toEqual([
      "apr_q8t1",
      "apr_next",
    ]);
    // The walk reached the end of the ledger, so nothing says it is partial.
    expect(out.ok && out.value.more).toBe(false);
    expect(kernelRead).toHaveBeenCalledTimes(2);
    expect(kernelRead).toHaveBeenNthCalledWith(2, ctx, {
      contract: agentApprovalListResolved,
      input: { runId: "arun_7k2m9q", limit: 100, cursor: "c2" },
      page: "run",
    });
  });

  // #3477: a run with more than 1,000 resolved approvals stops at the bound
  // and says so, rather than dropping the last cursor and reading as complete.
  it("stops at MAX_RESOLVED_PAGES and says the ledger holds more (negative)", async () => {
    let n = 0;
    kernelRead.mockImplementation(() => {
      n += 1;
      // Eleven full pages of 100: one more page than the bound takes.
      return Promise.resolve(
        readOk({
          items: Array.from({ length: 100 }, (_, i) => ({
            ...resolvedItem,
            id: `apr_p${n}r${i}`,
          })),
          nextCursor: n < 11 ? `c${n + 1}` : null,
        }),
      );
    });
    const out = await approvals.resolved(ctx, { runId: "arun_7k2m9q" });
    expect(kernelRead).toHaveBeenCalledTimes(10);
    expect(out.ok && out.value.items).toHaveLength(1_000);
    expect(out.ok && out.value.more).toBe(true);
  });

  it("reads exactly 1,000 rows as complete when the tenth page ends the ledger", async () => {
    let n = 0;
    kernelRead.mockImplementation(() => {
      n += 1;
      return Promise.resolve(
        readOk({
          items: Array.from({ length: 100 }, (_, i) => ({
            ...resolvedItem,
            id: `apr_p${n}r${i}`,
          })),
          nextCursor: n < 10 ? `c${n + 1}` : null,
        }),
      );
    });
    const out = await approvals.resolved(ctx, { runId: "arun_7k2m9q" });
    expect(kernelRead).toHaveBeenCalledTimes(10);
    expect(out.ok && out.value.items).toHaveLength(1_000);
    expect(out.ok && out.value.more).toBe(false);
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

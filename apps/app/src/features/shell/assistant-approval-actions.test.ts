// The approval rows behind an assistant turn's parked writes
// (assistant-approval-actions.ts), over a stubbed data source: the viewer is
// resolved before any read, both halves are read narrowed to the turn's run, a
// pending row reads as waiting and a resolved row keeps its resolution, who
// made it and what became of the call, and a refused read answers with the
// reason the store gave rather than a partial list that would read as settled.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readError } from "@/data/read";

const { source, requireViewer } = vi.hoisted(() => ({
  source: { approvals: { pending: vi.fn(), resolved: vi.fn() } },
  requireViewer: vi.fn(() => Promise.resolve({ wsSlug: "core" })),
}));
vi.mock("@/data/source", () => ({ dataSource: () => source }));
vi.mock("@/server/viewer", () => ({ requireViewer }));

const { readParkedApprovals } = await import("./assistant-approval-actions");

const ok = <T>(value: T) => ({ ok: true as const, value });
const RUN = "arun_01k9";

const pendingItem = {
  id: "apr_wait",
  runId: RUN,
  tool: "retire_agent",
  agentKey: null,
  requester: "usr_me",
  mandateId: null,
  rule: null,
  autoEligibility: null,
  createdAt: "2026-09-25T10:00:00.000Z",
  expiresAt: "2026-09-25T10:05:00.000Z",
};

const resolvedItem = {
  id: "apr_done",
  runId: RUN,
  tool: "set_kill_switch",
  requester: "usr_me",
  createdAt: "2026-09-25T10:00:00.000Z",
  expiresAt: "2026-09-25T10:05:00.000Z",
  resolvedAt: "2026-09-25T10:01:00.000Z",
  resolution: "approved",
  resolvedBy: "user:usr_other",
  autoRuleRef: null,
  execution: { status: "succeeded", runId: "arun_resumed", reason: null },
};

beforeEach(() => {
  vi.clearAllMocks();
  source.approvals.pending.mockResolvedValue(
    ok({ items: [pendingItem], more: false }),
  );
  source.approvals.resolved.mockResolvedValue(
    ok({ items: [resolvedItem], more: false }),
  );
});

describe("readParkedApprovals", () => {
  it("reads both halves for the turn's run, as the viewer, and answers one row per approval", async () => {
    const result = await readParkedApprovals("acme", "core", RUN);
    expect(requireViewer).toHaveBeenCalledWith("acme", "core");
    expect(source.approvals.pending).toHaveBeenCalledWith(
      { wsSlug: "core" },
      { runId: RUN },
    );
    expect(source.approvals.resolved).toHaveBeenCalledWith(
      { wsSlug: "core" },
      { runId: RUN },
    );
    expect(result).toEqual({
      ok: true,
      value: {
        rows: [
          {
            id: "apr_wait",
            state: "waiting",
            expiresAt: "2026-09-25T10:05:00.000Z",
          },
          {
            id: "apr_done",
            state: "approved",
            resolvedBy: "user:usr_other",
            resolvedAt: "2026-09-25T10:01:00.000Z",
            execution: {
              status: "succeeded",
              runId: "arun_resumed",
              reason: null,
            },
          },
        ],
      },
    });
  });

  it("answers no execution for a resolved row that records none", async () => {
    const { execution: _none, ...legacy } = resolvedItem;
    source.approvals.resolved.mockResolvedValue(
      ok({ items: [{ ...legacy, resolution: "denied" }], more: false }),
    );
    const result = await readParkedApprovals("acme", "core", RUN);
    expect(result.ok && result.value.rows[1]).toMatchObject({
      state: "denied",
      execution: null,
    });
  });

  it("fails with the pending read's reason rather than answering half (negative)", async () => {
    source.approvals.pending.mockResolvedValue(
      readError("approvals_unavailable", 503),
    );
    expect(await readParkedApprovals("acme", "core", RUN)).toEqual({
      ok: false,
      reason: "unavailable",
      code: "approvals_unavailable",
    });
  });

  it("carries a refused resolved read as a denial, not as an outage (negative)", async () => {
    source.approvals.resolved.mockResolvedValue({
      ok: false,
      reason: "denied",
      permission: "approvals.read",
    });
    expect(await readParkedApprovals("acme", "core", RUN)).toEqual({
      ok: false,
      reason: "denied",
      code: "approvals.read",
    });
  });
});

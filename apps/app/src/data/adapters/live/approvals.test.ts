import { getScope } from "@oxagen/tenancy";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The database seam is faked; runInTenantScope is real, so the tests see the
// scope each query ran under. The fake transaction pops one scripted result
// per query and records the table it read.
const { queue, reads, withTenantDbMock } = vi.hoisted(() => {
  const queue: unknown[][] = [];
  const reads: Array<{ table: unknown; scope: unknown }> = [];
  const limit = vi.fn(() => Promise.resolve(queue.shift() ?? []));
  const orderBy = vi.fn(() => ({ limit }));
  const where = vi.fn(() => ({ limit, orderBy }));
  const tx = {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => {
        reads.push({ table, scope: currentScope() });
        return { where };
      }),
    })),
  };
  let currentScope: () => unknown = () => null;
  const withTenantDbMock = vi.fn(
    (fn: (t: typeof tx) => Promise<unknown>, scopeOf?: () => unknown) => {
      if (scopeOf) currentScope = scopeOf;
      return fn(tx);
    },
  );
  return { queue, reads, withTenantDbMock };
});

vi.mock("@oxagen/database", async () => ({
  schema: await vi.importActual("@oxagen/database/schema"),
  withTenantDb: (fn: (tx: unknown) => Promise<unknown>) =>
    withTenantDbMock(fn, () => getScope()),
}));

// When set, the mapper returns this candidate instead of mapping the row: it
// stands in for a store that records the whole chain, so the recorded-queue
// path (items and the run filter) is exercised before the store exists.
const recorded = vi.hoisted(() => ({
  candidate: null as null | ((row: { publicId: string }) => unknown),
}));

vi.mock("./mappers/approvals", async () => {
  const actual = await vi.importActual<typeof import("./mappers/approvals")>(
    "./mappers/approvals",
  );
  return {
    ...actual,
    toApprovalCandidate: (
      ...args: Parameters<typeof actual.toApprovalCandidate>
    ) =>
      recorded.candidate
        ? recorded.candidate(args[0])
        : actual.toApprovalCandidate(...args),
  };
});

import * as schema from "@oxagen/database/schema";
import { ORG_ONLY_WORKSPACE_ID } from "@/data/scope";
import {
  ApprovalContractMismatch,
  type ApprovalStore,
  COMMAND_IDS_LIMIT,
  createLiveApprovals,
  createLiveCommandDeliveries,
  dbApprovalStore,
  liveApprovals,
  liveCommandDeliveries,
} from "./approvals";
import type {
  ApprovalRequestRow,
  ControlCommandRow,
} from "./mappers/approvals";

const NOW = new Date("2026-09-12T10:00:00.000Z");
const clock = () => NOW;
const SCOPE = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-00000000c0de",
};
const ORG_SCOPE = { orgId: SCOPE.orgId, workspaceId: ORG_ONLY_WORKSPACE_ID };

function approvalRow(
  over: Partial<ApprovalRequestRow> = {},
): ApprovalRequestRow {
  return {
    id: "0192d4a8-7c1e-7a00-8000-0000000a9001",
    publicId: "apr_7k2m9q4x8c1v5b3n6z0r2t",
    createdAt: new Date("2026-09-12T09:58:00.000Z"),
    updatedAt: new Date("2026-09-12T09:58:00.000Z"),
    createdByUserId: null,
    updatedByUserId: null,
    ...SCOPE,
    executionStepId: null,
    toolCallId: null,
    messageId: "0192d4a8-7c1e-7a00-8000-0000000e5500",
    capabilityName: "workspace.create",
    inputPreview: {},
    riskLevel: "high",
    resolution: null,
    resolvedAt: null,
    resolvedByUserId: null,
    note: null,
    expiresAt: new Date("2026-09-12T10:03:00.000Z"),
    ...over,
  };
}

function commandRow(over: Partial<ControlCommandRow> = {}): ControlCommandRow {
  return {
    id: "0192d4a8-7c1e-7a00-8000-0000000cc001",
    publicId: "tcm_4f8h2k6m0p3r7t1v5x9z2b",
    createdAt: new Date("2026-09-12T09:59:00.000Z"),
    updatedAt: new Date("2026-09-12T09:59:00.000Z"),
    createdByUserId: null,
    updatedByUserId: null,
    ...SCOPE,
    hostId: "0192d4a8-7c1e-7a00-8000-0000000b0571",
    sessionId: null,
    command: "resume",
    payload: {},
    issuedByPrincipalId: null,
    issuedByUserId: null,
    issuedAt: new Date("2026-09-12T09:59:00.000Z"),
    expiresAt: new Date("2026-09-12T10:59:00.000Z"),
    deliveredAt: new Date("2026-09-12T09:59:30.000Z"),
    acknowledgedAt: null,
    appliedAt: null,
    appliedAtSeq: null,
    outcome: "delivered",
    outcomeDetail: null,
    ...over,
  };
}

function fakeStore(
  approvals: { workspaceSlug: string | null; rows: ApprovalRequestRow[] },
  commands: ControlCommandRow[] = [],
) {
  return {
    openApprovals: vi.fn(() => Promise.resolve(approvals)),
    commands: vi.fn(() => Promise.resolve(commands)),
  } satisfies ApprovalStore;
}

beforeEach(() => {
  queue.length = 0;
  reads.length = 0;
  recorded.candidate = null;
});

/** An approval whose whole chain is recorded (the fixture's shape, spec §6.7). */
function recordedItem(publicId: string, runId: string | null) {
  return {
    id: publicId,
    runId,
    workspaceSlug: "core-platform",
    status: "pending",
    chain: {
      operatorId: "usr_marcusbell",
      agentKey: "acme.core.release-manager",
      action: "github__create_release@2",
      trigger: null,
    },
    risk: "high",
    sideEffect: "write",
    egress: "third_party",
    amount: null,
    counterparty: null,
    mandateId: null,
    policyVersionId: null,
    inputDigest: "sha256:0a1b2c",
    tainted: null,
    tier: "gateway",
    requestedAt: "2026-09-12T09:58:00.000Z",
    expiresAt: "2026-09-12T10:03:00.000Z",
    approvers: {
      roles: ["release_manager"],
      eligiblePersonIds: [],
      excluded: [],
    },
    rules: null,
    taintSources: null,
  };
}

describe("liveApprovals.pending", () => {
  it("reads unresolved approvals from fifteen minutes before now", async () => {
    const store = fakeStore({ workspaceSlug: null, rows: [] });
    await createLiveApprovals(store, clock).pending(SCOPE);
    expect(store.openApprovals).toHaveBeenCalledWith(
      SCOPE,
      new Date("2026-09-12T09:45:00.000Z"),
    );
  });

  it("returns an empty queue when nothing is open: a recorded fact", async () => {
    const port = createLiveApprovals(
      fakeStore({ workspaceSlug: null, rows: [] }),
      clock,
    );
    await expect(port.pending(SCOPE)).resolves.toEqual({ ok: true, value: [] });
    await expect(
      port.pending(SCOPE, { runId: "arun_01k5rs" }),
    ).resolves.toEqual({ ok: true, value: [] });
  });

  it("reports open approvals as not backed (G1), never as an empty queue", async () => {
    const port = createLiveApprovals(
      fakeStore({ workspaceSlug: "core-platform", rows: [approvalRow()] }),
      clock,
    );
    await expect(port.pending(SCOPE)).resolves.toEqual({
      ok: false,
      reason: "not_backed",
      milestone: "M2",
      gap: "G1",
    });
    await expect(
      port.pending(SCOPE, { runId: "arun_01k5rs" }),
    ).resolves.toMatchObject({ reason: "not_backed", gap: "G1" });
  });

  it("refuses an organization-only scope: approvals are workspace rows", async () => {
    const store = fakeStore({ workspaceSlug: null, rows: [] });
    await expect(
      createLiveApprovals(store, clock).pending(ORG_SCOPE),
    ).resolves.toEqual({
      ok: false,
      reason: "error",
      code: "workspace_required",
      status: 400,
    });
    expect(store.openApprovals).not.toHaveBeenCalled();
  });

  it("reports a workspace the scope cannot see as not found", async () => {
    const port = createLiveApprovals(
      fakeStore({ workspaceSlug: null, rows: [approvalRow()] }),
      clock,
    );
    await expect(port.pending(SCOPE)).resolves.toEqual({
      ok: false,
      reason: "error",
      code: "workspace_not_found",
      status: 404,
    });
  });

  it("throws on a mismatch at a recorded path instead of calling it not backed", async () => {
    // Year 10000 serialises as "+010000-…", which the Instant schema rejects:
    // a recorded column the view model cannot take is a bug to surface.
    const port = createLiveApprovals(
      fakeStore({
        workspaceSlug: "core-platform",
        rows: [approvalRow({ expiresAt: new Date(Date.UTC(10_000, 0, 1)) })],
      }),
      clock,
    );
    const failure = port.pending(SCOPE);
    await expect(failure).rejects.toBeInstanceOf(ApprovalContractMismatch);
    await expect(failure).rejects.toMatchObject({ paths: ["expiresAt"] });
  });

  it("names the recorded paths in a contract mismatch", () => {
    const err = new ApprovalContractMismatch(["requestedAt"]);
    expect(err.code).toBe("approval_contract_mismatch");
    expect(err.message).toContain("requestedAt");
  });

  it("propagates a store failure: the page's error boundary renders it", async () => {
    const store = fakeStore({ workspaceSlug: null, rows: [] });
    store.openApprovals.mockRejectedValueOnce(new Error("connection refused"));
    await expect(
      createLiveApprovals(store, clock).pending(SCOPE),
    ).rejects.toThrow("connection refused");
  });

  it("returns the recorded queue, and filters it by run, once the chain is recorded", async () => {
    recorded.candidate = (row) =>
      recordedItem(
        row.publicId,
        row.publicId === "apr_first" ? "arun_one" : "arun_two",
      );
    const port = createLiveApprovals(
      fakeStore({
        workspaceSlug: "core-platform",
        rows: [
          approvalRow({ publicId: "apr_first" }),
          approvalRow({ publicId: "apr_second" }),
        ],
      }),
      clock,
    );
    const all = await port.pending(SCOPE);
    expect(all.ok && all.value.map((i) => i.id)).toEqual([
      "apr_first",
      "apr_second",
    ]);
    const one = await port.pending(SCOPE, { runId: "arun_two" });
    expect(one.ok && one.value.map((i) => i.id)).toEqual(["apr_second"]);
  });

  it("reports a run-filtered read as not backed when an open approval has no recorded run id, never as an empty run queue", async () => {
    // Once the contract makes runId nullable these items parse; filtering them
    // out would tell the Run page nothing is waiting while a call is parked.
    recorded.candidate = (row) =>
      recordedItem(
        row.publicId,
        row.publicId === "apr_first" ? "arun_one" : null,
      );
    const port = createLiveApprovals(
      fakeStore({
        workspaceSlug: "core-platform",
        rows: [
          approvalRow({ publicId: "apr_first" }),
          approvalRow({ publicId: "apr_second" }),
        ],
      }),
      clock,
    );
    const filtered = await port.pending(SCOPE, { runId: "arun_x" });
    expect(filtered).toEqual({
      ok: false,
      reason: "not_backed",
      milestone: "M2",
      gap: "G1",
    });
    expect(filtered).not.toEqual({ ok: true, value: [] });
    await expect(
      port.pending(SCOPE, { runId: "arun_one" }),
    ).resolves.toMatchObject({ ok: false, reason: "not_backed" });

    recorded.candidate = (row) => recordedItem(row.publicId, null);
    await expect(port.pending(SCOPE, { runId: "arun_x" })).resolves.toEqual({
      ok: false,
      reason: "not_backed",
      milestone: "M2",
      gap: "G1",
    });
  });

  it("still throws on a recorded-path mismatch when a run filter is set", async () => {
    recorded.candidate = (row) => ({
      ...recordedItem(row.publicId, null),
      risk: "catastrophic",
    });
    const port = createLiveApprovals(
      fakeStore({ workspaceSlug: "core-platform", rows: [approvalRow()] }),
      clock,
    );
    await expect(
      port.pending(SCOPE, { runId: "arun_x" }),
    ).rejects.toBeInstanceOf(ApprovalContractMismatch);
  });

  it("is the port the live source registers, reading through the tenant database seam", async () => {
    await expect(liveApprovals.pending(ORG_SCOPE)).resolves.toMatchObject({
      code: "workspace_required",
    });
    queue.push([]);
    await expect(liveApprovals.pending(SCOPE)).resolves.toEqual({
      ok: true,
      value: [],
    });
    expect(reads.map((r) => r.table)).toEqual([schema.approvalRequests]);
  });
});

describe("liveCommandDeliveries", () => {
  it("maps each command row to its delivery report", async () => {
    const store = fakeStore({ workspaceSlug: null, rows: [] }, [commandRow()]);
    const read = createLiveCommandDeliveries(store, clock);
    await expect(read(SCOPE, ["tcm_4f8h2k6m0p3r7t1v5x9z2b"])).resolves.toEqual({
      ok: true,
      value: [
        {
          id: "tcm_4f8h2k6m0p3r7t1v5x9z2b",
          command: "resume",
          status: "sent",
          issuedAt: "2026-09-12T09:59:00.000Z",
          expiresAt: "2026-09-12T10:59:00.000Z",
          deliveredAt: "2026-09-12T09:59:30.000Z",
          acknowledgedAt: null,
          appliedAt: null,
          appliedAtSeq: null,
          detail: null,
        },
      ],
    });
    expect(store.commands).toHaveBeenCalledWith(SCOPE, [
      "tcm_4f8h2k6m0p3r7t1v5x9z2b",
    ]);
  });

  it("answers no ids without reading the store", async () => {
    const store = fakeStore({ workspaceSlug: null, rows: [] });
    await expect(
      createLiveCommandDeliveries(store, clock)(SCOPE, []),
    ).resolves.toEqual({ ok: true, value: [] });
    expect(store.commands).not.toHaveBeenCalled();
  });

  it("refuses ids that are not public ids, or too many of them", async () => {
    const store = fakeStore({ workspaceSlug: null, rows: [] });
    const read = createLiveCommandDeliveries(store, clock);
    const invalid = {
      ok: false,
      reason: "error",
      code: "invalid_command_ids",
      status: 400,
    };
    await expect(read(SCOPE, ["'; drop table"])).resolves.toEqual(invalid);
    await expect(
      read(
        SCOPE,
        Array.from(
          { length: COMMAND_IDS_LIMIT + 1 },
          (_, i) => `tcm_${String(i)}`,
        ),
      ),
    ).resolves.toEqual(invalid);
    expect(store.commands).not.toHaveBeenCalled();
  });

  it("refuses an organization-only scope", async () => {
    const store = fakeStore({ workspaceSlug: null, rows: [] });
    await expect(
      createLiveCommandDeliveries(store, clock)(ORG_SCOPE, ["tcm_a"]),
    ).resolves.toMatchObject({ code: "workspace_required" });
    await expect(
      liveCommandDeliveries(ORG_SCOPE, ["tcm_a"]),
    ).resolves.toMatchObject({ code: "workspace_required" });
    queue.push([]);
    await expect(liveCommandDeliveries(SCOPE, ["tcm_a"])).resolves.toEqual({
      ok: true,
      value: [],
    });
    expect(store.commands).not.toHaveBeenCalled();
  });
});

describe("dbApprovalStore", () => {
  it("reads approvals, then the workspace slug, inside the viewer's tenant scope", async () => {
    const row = approvalRow();
    queue.push([row], [{ slug: "core-platform" }]);
    await expect(dbApprovalStore.openApprovals(SCOPE, NOW)).resolves.toEqual({
      workspaceSlug: "core-platform",
      rows: [row],
    });
    expect(reads.map((r) => r.table)).toEqual([
      schema.approvalRequests,
      schema.workspaces,
    ]);
    for (const r of reads) expect(r.scope).toMatchObject(SCOPE);
  });

  it("skips the workspace read when no approval is open", async () => {
    queue.push([]);
    await expect(dbApprovalStore.openApprovals(SCOPE, NOW)).resolves.toEqual({
      workspaceSlug: null,
      rows: [],
    });
    expect(reads.map((r) => r.table)).toEqual([schema.approvalRequests]);
  });

  it("returns a null slug when the workspace row is not visible", async () => {
    queue.push([approvalRow()], []);
    await expect(
      dbApprovalStore.openApprovals(SCOPE, NOW),
    ).resolves.toMatchObject({ workspaceSlug: null });
  });

  it("reads control commands inside the viewer's tenant scope", async () => {
    const row = commandRow();
    queue.push([row]);
    await expect(
      dbApprovalStore.commands(SCOPE, [row.publicId]),
    ).resolves.toEqual([row]);
    expect(reads.map((r) => r.table)).toEqual([schema.tachoControlCommands]);
    expect(reads[0]?.scope).toMatchObject(SCOPE);
  });

  it("refuses to query outside a valid tenant scope", () => {
    expect(() =>
      dbApprovalStore.openApprovals(
        { orgId: "nope", workspaceId: "nope" },
        NOW,
      ),
    ).toThrow();
    expect(withTenantDbMock).not.toHaveBeenCalled();
  });
});

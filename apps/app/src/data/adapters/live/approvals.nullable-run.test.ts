import { beforeEach, describe, expect, it, vi } from "vitest";

// Promote item 2 asks c1-promote to make ApprovalItem.runId nullable. This file
// runs the adapter against that future contract, so the run filter's guard is
// proven where it matters: once rows with no run id parse, a run-filtered read
// must still say "not backed" instead of filtering them away to an empty queue.
vi.mock("@/data/contracts", async () => {
  const actual =
    await vi.importActual<typeof import("@/data/contracts")>(
      "@/data/contracts",
    );
  return {
    ...actual,
    ApprovalItem: actual.ApprovalItem.extend({
      runId: actual.PublicId.nullable(),
    }),
  };
});

vi.mock("@oxagen/database", async () => ({
  schema: await vi.importActual("@oxagen/database/schema"),
  withTenantDb: vi.fn(() => {
    throw new Error("the fake store never reaches the database");
  }),
}));

// Stands in for a store that records the whole chain except the run id.
const recorded = vi.hoisted(() => ({
  runIdOf: (_publicId: string): string | null => null,
}));

vi.mock("./mappers/approvals", async () => {
  const actual = await vi.importActual<typeof import("./mappers/approvals")>(
    "./mappers/approvals",
  );
  return {
    ...actual,
    toApprovalCandidate: (row: { publicId: string }) => ({
      id: row.publicId,
      runId: recorded.runIdOf(row.publicId),
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
    }),
  };
});

import { type ApprovalStore, createLiveApprovals } from "./approvals";
import type { ApprovalRequestRow } from "./mappers/approvals";

const NOW = new Date("2026-09-12T10:00:00.000Z");
const SCOPE = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-00000000c0de",
};
const NOT_BACKED = {
  ok: false,
  reason: "not_backed",
  milestone: "M2",
  gap: "G1",
};

function port(publicIds: string[]) {
  const rows = publicIds.map(
    (publicId) => ({ publicId }) as ApprovalRequestRow,
  );
  const store: ApprovalStore = {
    openApprovals: vi.fn(() =>
      Promise.resolve({ workspaceSlug: "core-platform", rows }),
    ),
    commands: vi.fn(() => Promise.resolve([])),
  };
  return createLiveApprovals(store, () => NOW);
}

beforeEach(() => {
  recorded.runIdOf = () => null;
});

describe("liveApprovals.pending once ApprovalItem.runId is nullable", () => {
  it("returns the workspace queue: items with no run id are real open approvals", async () => {
    const read = await port(["apr_first", "apr_second"]).pending(SCOPE);
    expect(read.ok && read.value.map((i) => i.id)).toEqual([
      "apr_first",
      "apr_second",
    ]);
  });

  it("reports a run-filtered read as not backed, never ok: [], while an open approval has no run id", async () => {
    const read = await port(["apr_first"]).pending(SCOPE, {
      runId: "arun_x",
    });
    expect(read).toEqual(NOT_BACKED);
    expect(read).not.toEqual({ ok: true, value: [] });
  });

  it("stays not backed when only some approvals carry a run id", async () => {
    recorded.runIdOf = (id) => (id === "apr_first" ? "arun_one" : null);
    const approvals = port(["apr_first", "apr_second"]);
    await expect(
      approvals.pending(SCOPE, { runId: "arun_x" }),
    ).resolves.toEqual(NOT_BACKED);
    await expect(
      approvals.pending(SCOPE, { runId: "arun_one" }),
    ).resolves.toEqual(NOT_BACKED);
  });

  it("filters by run when every approval carries a run id", async () => {
    recorded.runIdOf = (id) => (id === "apr_first" ? "arun_one" : "arun_two");
    const read = await port(["apr_first", "apr_second"]).pending(SCOPE, {
      runId: "arun_two",
    });
    expect(read.ok && read.value.map((i) => i.id)).toEqual(["apr_second"]);
  });
});

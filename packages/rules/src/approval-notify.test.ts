/**
 * The one `approval.requested` fan-out, tested where it lives rather than
 * through either of its two callers.
 *
 * The defect this module exists to close was structural: the fan-out was a
 * block of code inside the runtime's `createApprovalRequest`, so the mandate
 * gate — the OTHER writer of an approval row, and the one that parks a call
 * precisely because a rule decided a person must see it — inserted its rows
 * and told nobody. `packages/rules/src/mandates.pg.test.ts` asserts that the
 * mandate path now fans out against real Postgres; these cases pin the
 * function's own behaviour without one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { warnSpy } = vi.hoisted(() => ({ warnSpy: vi.fn() }));
vi.mock("./logger", () => ({
  logger: { warn: warnSpy, error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { schema, type Tx } from "@oxagen/database";
import {
  APPROVAL_NOTIFY_CHUNK,
  APPROVAL_NOTIFY_MAX_RECIPIENTS,
  APPROVAL_RESOLVER_ROLES,
  notifyApprovalRequested,
} from "./approval-notify";

let approverRows: Array<{ userId: string | null }> = [];
let inserted: Array<{ table: unknown; values: unknown[] }> = [];

function fakeTx(): Tx {
  const limit = vi.fn(async () => approverRows);
  const chain = {
    innerJoin: () => chain,
    where: () => ({ limit }),
  };
  return {
    select: () => ({ from: () => chain }),
    insert: (table: unknown) => ({
      values: async (values: unknown[]) => {
        inserted.push({ table, values });
      },
    }),
  } as unknown as Tx;
}

const ARGS = {
  orgId: "org_1",
  workspaceId: "ws_1",
  capabilityName: "issue_refund",
  riskLevel: "critical",
  expiresAt: new Date("2026-02-03T04:05:06.000Z"),
};

beforeEach(() => {
  approverRows = [];
  inserted = [];
  warnSpy.mockClear();
});

describe("notifyApprovalRequested", () => {
  it("writes one approval.requested row per person who may resolve it", async () => {
    approverRows = [{ userId: "u_owner" }, { userId: "u_admin" }];

    await notifyApprovalRequested(fakeTx(), ARGS);

    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.table).toBe(schema.notifications);
    expect(inserted[0]!.values).toEqual([
      {
        orgId: "org_1",
        workspaceId: "ws_1",
        userId: "u_owner",
        kind: "approval",
        event: "approval.requested",
        title: "Approval requested: issue_refund",
        body: "Risk critical. Expires 2026-02-03T04:05:06.000Z.",
        deepLink: null,
      },
      expect.objectContaining({ userId: "u_admin" }),
    ]);
  });

  it("writes nothing at all when nobody may resolve it", async () => {
    // An empty fan-out must not issue an INSERT with zero rows — Drizzle
    // builds `VALUES ()`, which Postgres refuses, and that would fail the
    // approval's own transaction.
    await notifyApprovalRequested(fakeTx(), ARGS);
    expect(inserted).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("de-duplicates a person holding several admitted roles", async () => {
    // The join returns one row per assignment, so an Owner who is also a
    // workspace Member appears twice. Notifying them twice would put the same
    // card in the feed twice.
    approverRows = [
      { userId: "u_both" },
      { userId: "u_both" },
      { userId: null },
    ];

    await notifyApprovalRequested(fakeTx(), ARGS);

    expect(inserted[0]!.values).toHaveLength(1);
    expect(inserted[0]!.values[0]).toMatchObject({ userId: "u_both" });
  });

  it("caps and chunks so one approval can never outgrow a statement", async () => {
    // `APPROVAL_RESOLVER_ROLES.workspace` is Owner and Member — effectively
    // everyone — so an unbounded fan-out writes one row per member inside the
    // approval's transaction. Near 8,000 people it crosses Postgres's 65,535
    // bind-parameter ceiling and takes the approval down with it.
    expect(APPROVAL_RESOLVER_ROLES.workspace.length).toBeGreaterThan(1);
    approverRows = Array.from(
      { length: APPROVAL_NOTIFY_MAX_RECIPIENTS + 37 },
      (_, i) => ({ userId: `u_${i}` }),
    );

    await notifyApprovalRequested(fakeTx(), ARGS);

    expect(inserted.flatMap((i) => i.values)).toHaveLength(
      APPROVAL_NOTIFY_MAX_RECIPIENTS,
    );
    for (const batch of inserted) {
      expect(batch.values.length).toBeLessThanOrEqual(APPROVAL_NOTIFY_CHUNK);
    }
    // Truncation is a real loss of reach, so it is visible rather than silent.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        notified: APPROVAL_NOTIFY_MAX_RECIPIENTS,
        capabilityName: "issue_refund",
      }),
      expect.stringContaining("fan-out truncated"),
    );
  });
});

// The Postgres command store's ledger seams, against a fake transaction. The
// pg suite (`lib/run-token.pg.test.ts`) proves the fence, the revocation and
// the receipt commit or roll back together; this file holds the ordering of
// the refusals, and of the lock a next-run steer takes, which need no
// database to state.
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  lockRunForControl: vi.fn(),
  cancelRunInTransaction: vi.fn(),
  setRunIngressPaused: vi.fn(),
  revokeRunTokens: vi.fn(),
}));

vi.mock("@oxagen/run-ledger", async (importOriginal) => {
  const original = await importOriginal<typeof import("@oxagen/run-ledger")>();
  return {
    ...original,
    lockRunForControl: mocks.lockRunForControl,
    cancelRunInTransaction: mocks.cancelRunInTransaction,
    setRunIngressPaused: mocks.setRunIngressPaused,
    createPostgresRunStore: () => ({}),
  };
});
vi.mock("./lib/run-token", () => ({ revokeRunTokens: mocks.revokeRunTokens }));
vi.mock("./logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { postgresCommandStore } from "./tacho.command.dispatch";

const scope = {
  orgId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
};
const RUN = "arun_5f0c2e9a1b7d4c3e8f6a02";
const NOW = new Date("2026-09-22T10:00:00.000Z");

/** A transaction whose one receipt lookup answers `receipts`. */
function fakeTx(receipts: Array<{ publicId: string }>) {
  const inserted: unknown[] = [];
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({ limit: async () => receipts }),
        }),
      }),
    }),
    insert: () => ({
      values: (row: unknown) => {
        inserted.push(row);
        return { returning: async () => [{ publicId: "tcm_new" }] };
      },
    }),
  };
  return { tx: tx as never, inserted };
}

const control = {
  scope,
  publicId: RUN,
  userId: "00000000-0000-4000-8000-0000000000aa",
  now: NOW,
  expiresAt: NOW,
  reason: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("cancelLedgerRun", () => {
  it("answers a cancel retried after the seal with the existing receipt", async () => {
    // `cancelRunInTransaction` only sets `cancelRequested`; the status turns
    // `cancelled` when the producer seals. A retry after that seal used to be
    // refused `run_sealed` because the status was checked first.
    mocks.lockRunForControl.mockResolvedValue({
      id: "run-uuid",
      publicId: RUN,
      status: "cancelled",
      cancelled: true,
      paused: false,
    });
    const { tx, inserted } = fakeTx([{ publicId: "tcm_first_cancel" }]);

    await expect(
      postgresCommandStore(tx).cancelLedgerRun(control),
    ).resolves.toBe("tcm_first_cancel");
    expect(mocks.cancelRunInTransaction).not.toHaveBeenCalled();
    expect(mocks.revokeRunTokens).not.toHaveBeenCalled();
    expect(inserted).toEqual([]);
  });

  it("answers a cancel retried after the run failed with no attempt with the existing receipt (#3665)", async () => {
    // The cancel landed between `openAssistantRun` creating the run and
    // creating its attempt. `createAttempt` saw the cancel and
    // `terminalizeUnattemptedRun` finished the run `failed`, keeping
    // `cancelRequested`. A retry after a lost response must return the
    // receipt it already applied, not a `run_sealed` refusal.
    mocks.lockRunForControl.mockResolvedValue({
      id: "run-uuid",
      publicId: RUN,
      status: "failed",
      cancelled: true,
      paused: false,
    });
    const { tx, inserted } = fakeTx([{ publicId: "tcm_first_cancel" }]);

    await expect(
      postgresCommandStore(tx).cancelLedgerRun(control),
    ).resolves.toBe("tcm_first_cancel");
    expect(mocks.cancelRunInTransaction).not.toHaveBeenCalled();
    expect(mocks.revokeRunTokens).not.toHaveBeenCalled();
    expect(inserted).toEqual([]);
  });

  it("refuses a run that ended without a cancel", async () => {
    mocks.lockRunForControl.mockResolvedValue({
      id: "run-uuid",
      publicId: RUN,
      status: "completed",
      cancelled: false,
      paused: false,
    });
    const { tx, inserted } = fakeTx([]);

    await expect(
      postgresCommandStore(tx).cancelLedgerRun(control),
    ).rejects.toMatchObject({ code: "conflict", reason: "run_sealed" });
    expect(mocks.cancelRunInTransaction).not.toHaveBeenCalled();
    expect(inserted).toEqual([]);
  });

  it("fences, revokes and writes the receipt for a live run", async () => {
    mocks.lockRunForControl.mockResolvedValue({
      id: "run-uuid",
      publicId: RUN,
      status: "running",
      cancelled: false,
      paused: false,
    });
    const { tx, inserted } = fakeTx([]);

    await expect(
      postgresCommandStore(tx).cancelLedgerRun(control),
    ).resolves.toBe("tcm_new");
    expect(mocks.cancelRunInTransaction).toHaveBeenCalledWith(
      tx,
      "run-uuid",
      NOW,
    );
    expect(mocks.revokeRunTokens).toHaveBeenCalledWith(
      tx,
      scope,
      "run-uuid",
      NOW,
    );
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      command: "cancel",
      targetId: RUN,
      outcomeDetail: "ledger_ingress_revoked",
    });
  });
});

describe("setLedgerPaused", () => {
  it.each(["pause", "resume"] as const)(
    "refuses to %s a cancelled run and says which control it refused",
    async (command) => {
      mocks.lockRunForControl.mockResolvedValue({
        id: "run-uuid",
        publicId: RUN,
        status: "running",
        cancelled: true,
        paused: command === "resume",
      });
      const { tx } = fakeTx([]);

      await expect(
        postgresCommandStore(tx).setLedgerPaused({ ...control, command }),
      ).rejects.toMatchObject({
        code: "conflict",
        reason: "run_cancelled",
        message: `The run was cancelled. Its evidence ingress cannot be ${command}d`,
      });
      expect(mocks.setRunIngressPaused).not.toHaveBeenCalled();
    },
  );
});

describe("queueForNextRun", () => {
  const AGENT = "acme.api.reviewer";
  const next = {
    scope,
    agentKey: AGENT,
    command: "steer" as const,
    payload: { address: "run", text: "Use the staging bucket." },
    requestedMode: null,
    reason: null,
    issuedByUserId: control.userId,
    issuedAt: NOW,
    expiresAt: NOW,
  };

  /** A transaction that answers `hosts` and records each step in order. */
  function queueTx(hosts: Array<{ id: string }>) {
    const steps: string[] = [];
    const locks: SQL[] = [];
    const tx = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              steps.push("host");
              return hosts;
            },
          }),
        }),
      }),
      execute: async (query: SQL) => {
        steps.push("lock");
        locks.push(query);
      },
      insert: () => ({
        values: () => ({
          returning: async () => {
            steps.push("insert");
            return [{ publicId: "tcm_new" }];
          },
        }),
      }),
      update: () => ({
        set: () => ({
          where: async () => {
            steps.push("supersede");
          },
        }),
      }),
    };
    return { tx: tx as never, steps, locks };
  }

  it("locks the agent's command kind before it inserts, so a concurrent dispatch cancels this row or is cancelled by it", async () => {
    // Without the lock, two dispatches each inserted before the other's row
    // was visible, and both steers stayed queued (Codex review on #4421).
    const { tx, steps, locks } = queueTx([{ id: "host-uuid" }]);

    await expect(postgresCommandStore(tx).queueForNextRun(next)).resolves.toBe(
      "tcm_new",
    );
    expect(steps).toEqual(["host", "lock", "insert", "supersede"]);
    const lock = new PgDialect().sqlToQuery(locks[0] as SQL);
    expect(lock.sql).toContain("pg_advisory_xact_lock(hashtextextended(");
    expect(lock.params).toEqual([
      `next_run_command:${scope.workspaceId}:${AGENT}:steer`,
    ]);
  });

  it("takes no lock when no host could open the agent's next run (negative)", async () => {
    const { tx, steps } = queueTx([]);

    await expect(
      postgresCommandStore(tx).queueForNextRun(next),
    ).resolves.toBeNull();
    expect(steps).toEqual(["host"]);
  });
});

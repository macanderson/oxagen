// The Postgres command store's ledger seams, against a fake transaction. The
// pg suite (`lib/run-token.pg.test.ts`) proves the fence, the revocation and
// the receipt commit or roll back together; this file holds the ordering of
// the refusals, which needs no database to state.
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

    await expect(postgresCommandStore(tx).cancelLedgerRun(control)).resolves.toBe(
      "tcm_first_cancel",
    );
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

    await expect(postgresCommandStore(tx).cancelLedgerRun(control)).resolves.toBe(
      "tcm_new",
    );
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

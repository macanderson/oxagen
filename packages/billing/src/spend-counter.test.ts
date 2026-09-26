// spend-counter.test.ts: which database the spend counter lands in.
//
// ADR-042 §2 and ADR-134 keep billing on the shared plane, and the gate reads
// the counter there through `withSystemDb`. These cases pin the write to the
// same plane: a caller's transaction is joined when it is on the shared
// plane, and a transaction on an organisation's dedicated plane is not (#4306).
// The plane comes from the real `runOnPlane` / `ambientPlaneKey` seam that
// `withTenantDb` and `withSystemDb` publish it through.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runOnPlane, type Tx } from "@oxagen/database";

const mocks = vi.hoisted(() => ({
  sharedExecute: vi.fn(async () => undefined),
  sharedSelect: vi.fn(),
  withSystemDb: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const original = await importOriginal<typeof import("@oxagen/database")>();
  // The system seam, as production opens it: on the shared plane.
  mocks.withSystemDb.mockImplementation(
    (fn: (tx: unknown) => Promise<unknown>) =>
      original.runOnPlane("shared", () =>
        fn({ execute: mocks.sharedExecute, select: mocks.sharedSelect }),
      ),
  );
  return { ...original, withSystemDb: mocks.withSystemDb };
});

import { recordSpend, sumSpendCounter } from "./spend-counter";

const ORG = "00000000-0000-0000-0000-00000000a111";
const WS = "00000000-0000-0000-0000-00000000b222";
const AT = new Date("2026-09-25T12:00:00Z");

function callerTx(): { tx: Tx; execute: ReturnType<typeof vi.fn> } {
  const execute = vi.fn(async () => undefined);
  return { tx: { execute } as unknown as Tx, execute };
}

const spend = { orgId: ORG, workspaceId: WS, at: AT, micros: 1_200n };

beforeEach(() => {
  mocks.sharedExecute.mockReset();
  mocks.sharedExecute.mockResolvedValue(undefined);
  mocks.withSystemDb.mockClear();
});

describe("recordSpend", () => {
  it("joins the caller's transaction on the shared plane", async () => {
    const { tx, execute } = callerTx();
    await runOnPlane("shared", () => recordSpend(spend, tx));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
  });

  it("joins a transaction opened outside any plane seam, which is the shared singleton", async () => {
    const { tx, execute } = callerTx();
    await recordSpend(spend, tx);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
  });

  it("writes the shared-plane counter when the caller's transaction is on a dedicated plane", async () => {
    const { tx, execute } = callerTx();
    await runOnPlane(`dedicated:org:${ORG}`, () => recordSpend(spend, tx));
    // Against main this wrote into the dedicated plane's own table, which the
    // gate never reads.
    expect(execute).not.toHaveBeenCalled();
    expect(mocks.withSystemDb).toHaveBeenCalledTimes(1);
    expect(mocks.sharedExecute).toHaveBeenCalledTimes(1);
  });

  it("rejects when the shared-plane write fails, so the dedicated caller rolls back", async () => {
    const { tx } = callerTx();
    mocks.sharedExecute.mockRejectedValueOnce(new Error("shared plane down"));
    await expect(
      runOnPlane(`dedicated:org:${ORG}`, () => recordSpend(spend, tx)),
    ).rejects.toThrow("shared plane down");
  });

  it("opens a shared-plane transaction when the caller passes none", async () => {
    await recordSpend(spend);
    expect(mocks.withSystemDb).toHaveBeenCalledTimes(1);
    expect(mocks.sharedExecute).toHaveBeenCalledTimes(1);
  });

  it("writes nothing for a non-positive amount", async () => {
    const { tx, execute } = callerTx();
    await recordSpend({ ...spend, micros: 0n }, tx);
    expect(execute).not.toHaveBeenCalled();
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
  });
});

describe("sumSpendCounter", () => {
  it("reads the counter on the shared plane", async () => {
    const where = vi.fn(async () => [{ micros: "2400" }]);
    mocks.sharedSelect.mockReturnValue({ from: () => ({ where }) });
    const total = await sumSpendCounter({
      orgId: ORG,
      workspaceId: WS,
      periodStart: AT,
      periodEnd: AT,
    });
    expect(total).toBe(2_400n);
    expect(mocks.withSystemDb).toHaveBeenCalledTimes(1);
  });
});

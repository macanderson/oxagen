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
import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

const mocks = vi.hoisted(() => ({
  sharedExecute: vi.fn(async (_query?: unknown) => undefined),
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

import {
  recordSpend,
  spendLaneOf,
  sumLaneSpendForDay,
  sumSpendCounter,
} from "./spend-counter";

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

  // #5426: the lane is part of the row's key, so each lane's daily budget
  // reads its own row and a call with no lane lands under ''.
  it("files the spend under its lane, and under '' when the call names none", async () => {
    const { tx, execute } = callerTx();
    await recordSpend({ ...spend, lane: "run_enrichment" }, tx);
    await recordSpend(spend, tx);
    const { PgDialect } = await import("drizzle-orm/pg-core");
    const bound = (call: number) =>
      new PgDialect().sqlToQuery(execute.mock.calls[call]?.[0] as never);
    expect(bound(0).sql).toContain("lane");
    expect(bound(0).params).toContain("run_enrichment");
    expect(bound(1).params).toContain("");
    expect(bound(1).params).not.toContain("run_enrichment");
  });
});

describe("spendLaneOf", () => {
  it("maps the capability a usage row names to its lane, and nothing else to a lane", () => {
    expect(spendLaneOf({ capability_name: "run_enrichment" })).toBe(
      "run_enrichment",
    );
    expect(spendLaneOf({ capability_name: "work_triage" })).toBe("work");
    expect(spendLaneOf({ capability_name: "work_brief_draft" })).toBe("work");
    expect(spendLaneOf({ capability_name: "ask_assistant" })).toBe("assistant");
    expect(spendLaneOf({ capability_name: "title_conversation" })).toBe(
      "assistant",
    );
    expect(spendLaneOf({ capability_name: "recall_memory" })).toBeNull();
    expect(spendLaneOf({ capability_name: "" })).toBeNull();
    expect(spendLaneOf({})).toBeNull();
  });
});

describe("sumLaneSpendForDay", () => {
  it("reads one lane's row for the UTC day on the shared plane", async () => {
    const where = vi.fn(async () => [{ micros: "150000" }]);
    mocks.sharedSelect.mockReturnValue({ from: () => ({ where }) });
    const total = await sumLaneSpendForDay({
      orgId: ORG,
      workspaceId: WS,
      lane: "assistant",
      at: AT,
    });
    expect(total).toBe(150_000n);
    expect(mocks.withSystemDb).toHaveBeenCalledTimes(1);
  });

  // #5426: a lane's budget resets at 00:00 UTC. The counter files a call
  // under the UTC day of the instant it settled, and the gate's read asks for
  // the UTC day of its own instant, so a lane spent on one day reads nothing
  // spent on the next.
  describe("the UTC day", () => {
    const LAST_INSTANT = new Date("2026-10-03T23:59:59.999Z");
    const NEXT_DAY = new Date("2026-10-04T00:00:00.000Z");

    /** The bound parameters of the day read for an instant. */
    async function dayReadParams(at: Date): Promise<unknown[]> {
      const where = vi.fn(async (_cond?: SQL) => [{ micros: "0" }]);
      mocks.sharedSelect.mockReturnValue({ from: () => ({ where }) });
      await sumLaneSpendForDay({ orgId: ORG, workspaceId: WS, lane: "work", at });
      const cond = where.mock.calls[0]?.[0];
      if (cond === undefined) throw new Error("the day read named no condition");
      return new PgDialect().sqlToQuery(cond).params;
    }

    it("reads the day an instant falls on, up to its last millisecond", async () => {
      const params = await dayReadParams(LAST_INSTANT);
      expect(params).toContain("2026-10-03");
      expect(params).not.toContain("2026-10-04");
      expect(params).toContain("work");
    });

    it("reads only the next day from 00:00 UTC, so the day before's spend is not counted", async () => {
      const params = await dayReadParams(NEXT_DAY);
      expect(params).toContain("2026-10-04");
      expect(params).not.toContain("2026-10-03");
    });

    it("takes the day in UTC when the process runs in another zone", async () => {
      // 20:30 on 3 October in Los Angeles (UTC-7) is 03:30 on 4 October in
      // UTC. CI runs in UTC, so the zone is moved for this case alone: a read
      // by the local calendar would ask for the 3rd.
      const zone = process.env.TZ;
      process.env.TZ = "America/Los_Angeles";
      try {
        const at = new Date("2026-10-03T20:30:00-07:00");
        expect(at.getDate()).toBe(3);
        const params = await dayReadParams(at);
        expect(params).toContain("2026-10-04");
        expect(params).not.toContain("2026-10-03");
      } finally {
        if (zone === undefined) delete process.env.TZ;
        else process.env.TZ = zone;
      }
    });

    it("files a call at the last millisecond of a day under that day", async () => {
      await recordSpend({ ...spend, at: LAST_INSTANT, lane: "work" });
      const query = mocks.sharedExecute.mock.calls[0]?.[0];
      if (!(query instanceof SQL)) throw new Error("the counter write ran no query");
      const { params } = new PgDialect().sqlToQuery(query);
      expect(params).toContain("2026-10-03");
      expect(params).not.toContain("2026-10-04");
    });
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

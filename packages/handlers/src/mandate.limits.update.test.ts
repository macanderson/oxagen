/**
 * `update_mandate_limits` and the merge it does under the row lock (ADR-102).
 *
 * The store is a double, so these cases are about one thing the Postgres suite
 * cannot show cheaply: WHERE the merge reads its stored limits. It reads them
 * from the record `lockMandate` returned inside the write transaction, not from
 * any earlier read — which is what makes a concurrent change safe. The double
 * therefore hands the handler two different records on purpose: `loadMandateRow`
 * answers a stale, wider one and `lockMandate` answers the current, lowered one,
 * so a merge over the wrong record is visible in what is written.
 *
 * The two-depth rule is the other half: a measure the change does not name keeps
 * its bound, and inside a named measure every field the change does not carry
 * keeps its stored value, `period` included. A bound can be deleted at either
 * depth, and a deleted bound is unbounded authority for that measure.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HandlerError, isHandlerError } from "@oxagen/oxagen";
import type { MandateLimits } from "@oxagen/oxagen/mandates/schemas";

const doubles = vi.hoisted(() => ({
  /** What `lockMandate` answers: the current record, under the lock. */
  locked: {
    limits: {} as MandateLimits,
    status: "active" as string,
    validTo: new Date("2027-01-01T00:00:00.000Z"),
  },
  /** What `loadMandateRow` answers: a stale snapshot, deliberately wider. */
  stale: {} as MandateLimits,
  /** Every `limits` value written, in order. */
  written: [] as MandateLimits[],
  lockCalls: 0,
  /**
   * Whether `hasDrawnInCurrentPeriod` answers drawn. False by default so the
   * merge cases stay about the merge; a period-rename case stubs true here.
   */
  drawn: false,
  /**
   * Whether `hasOpenReservation` answers open under any period key. Independent
   * of `drawn` so a midnight-crossed reserve can refuse a rename when the
   * current window is empty.
   */
  openReservation: false,
  /**
   * Whether `hasSettlementOverlappingPeriod` answers that a settle row's key
   * overlaps the destination window. Independent of `drawn` so a Monday settle
   * can refuse a Tuesday daily-to-weekly rename when today's key is empty.
   */
  overlappingSettlement: false,
  /**
   * What `lastLedgerKind` answers for a measure absent from `before`: the
   * kind the ledger's own most recent row for it was stamped under, or null
   * for a measure with no ledger history at all.
   */
  lastLedgerKind: null as "money" | "count" | null,
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const withTenantDb = async <T>(fn: (tx: unknown) => Promise<T>) =>
    fn({
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => [] }) }),
      }),
      update: () => ({
        set: (values: { limits: MandateLimits }) => {
          doubles.written.push(values.limits);
          // The write is the store: a second call locks what the first wrote,
          // which is how the sequential case below reaches the lost update.
          doubles.locked.limits = values.limits;
          return {
            where: () => ({
              returning: async () => [
                { publicId: "mnd_1", limits: values.limits },
              ],
            }),
          };
        },
      }),
    });
  return { ...real, withTenantDb, withOrgDb: withTenantDb };
});

vi.mock("@oxagen/database/security", () => ({
  emitSecurityEvent: vi.fn(),
  emitSecurityEventAsync: vi.fn(),
}));

vi.mock("@oxagen/iam/org-role", () => ({
  resolveActingUserId: async (ctx: { userId: string | null }) => ctx.userId,
  assertOrgRole: async () => "Owner",
}));

vi.mock("@oxagen/iam/mandate-role", () => ({
  assertConsequenceRole: async () => undefined,
  loadConsequenceRoles: async () => ({}),
}));

vi.mock("@oxagen/rules", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/rules")>()),
  lockMandate: async () => {
    doubles.lockCalls += 1;
    return {
      id: "11111111-1111-4111-8111-111111111111",
      publicId: "mnd_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      agentPrincipalId: "prn_1",
      consequenceTags: ["moves_money"],
      limits: doubles.locked.limits,
      // Every case here writes through limitChanges naming the measure it
      // asserts on, so nothing needs the untouched-measure kind preserved
      // from a real (non-legacy) prior stamp; an empty set keeps that path
      // out of these cases' way.
      legacyKindMeasures: new Set<string>(),
      targets: {},
      tools: ["stripe__create_payment@*"],
      approval: { humanAbove: {}, alwaysHumanFor: [], approvers: [] },
      status: doubles.locked.status,
      validFrom: new Date("2026-01-01T00:00:00.000Z"),
      validTo: doubles.locked.validTo,
    };
  },
  // Undrawn by default so the existing merge cases still write. A case that
  // renames a drawn window stubs true here. Open reservations under any key
  // are independent: a crossed-midnight park stubs openReservation alone.
  // Settlements under an earlier key that overlaps the destination window
  // stub overlappingSettlement alone.
  hasDrawnInCurrentPeriod: async () => doubles.drawn,
  hasOpenReservation: async () => doubles.openReservation,
  hasSettlementOverlappingPeriod: async () => doubles.overlappingSettlement,
  lastLedgerKind: async () => doubles.lastLedgerKind,
}));

vi.mock("./_mandate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./_mandate")>()),
  // The stale read the handler does before it locks anything: it is there for
  // the consequence tags, and the merge must not take its limits.
  loadMandateRow: async () => ({
    id: "11111111-1111-4111-8111-111111111111",
    publicId: "mnd_1",
    consequenceTags: ["moves_money"],
    limits: doubles.stale,
  }),
  // Passthrough (ADR-108): the real function stamps `kind` from the tool
  // declaration and returns the limits the handler persists. These cases are
  // about the merge, not the kind, so the double hands back what it was given
  // unchanged rather than fabricating a declaration.
  assertToolsDeclareMeasures: async (
    _tx: unknown,
    _workspaceId: string,
    args: { limits: MandateLimits },
  ) => args.limits,
  mapMandates: async () => [{ id: "mnd_1", status: "active" }],
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const {
  mandateLimitsUpdateHandler,
  applyLimitChanges,
  assertPeriodChangeAllowed,
  assertKindChangeAllowed,
} = await import("./mandate.limits.update");
const { mandateLimitsUpdate } = await import(
  "@oxagen/oxagen/contracts/mandate.limits.update"
);

const CTX = {
  orgId: "org_1",
  workspaceId: "ws_1",
  userId: "u_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "api" as const,
  messageId: null,
};

/** A bound in USD micros, the measure the change dialog cannot express. */
const AMOUNT = {
  perCall: "250000000",
  perPeriod: "2000000000",
  period: "monthly" as const,
  currencyOrUnit: "USD",
};

const CALLS = {
  perPeriod: "10",
  period: "weekly" as const,
  currencyOrUnit: "calls",
};

function change(input: Record<string, unknown>) {
  return mandateLimitsUpdateHandler(
    mandateLimitsUpdate.input.parse({ mandateId: "mnd_1", ...input }),
    CTX,
  );
}

function lastWritten(): MandateLimits {
  const written = doubles.written.at(-1);
  if (!written) throw new Error("no limits were written");
  return written;
}

beforeEach(() => {
  doubles.written = [];
  doubles.lockCalls = 0;
  doubles.locked.status = "active";
  doubles.locked.validTo = new Date("2027-01-01T00:00:00.000Z");
  doubles.locked.limits = { amount: AMOUNT, calls: CALLS };
  doubles.stale = { amount: AMOUNT, calls: CALLS };
  doubles.drawn = false;
  doubles.openReservation = false;
  doubles.overlappingSettlement = false;
  doubles.lastLedgerKind = null;
});

describe("update_mandate_limits, limitChanges", () => {
  // The defect this exists for. The app used to read the mandate, merge, and
  // post the whole record; the read was not under the lock, so a second
  // operator's stale snapshot could restore a bound the first one lowered.
  it("merges over the record the lock answered, not an earlier read", async () => {
    // What the record holds now: the amount cap has just been lowered.
    doubles.locked.limits = {
      amount: { ...AMOUNT, perPeriod: "500000000" },
      calls: CALLS,
    };
    // What a reader saw a moment earlier: the old, wider cap.
    doubles.stale = { amount: AMOUNT, calls: CALLS };
    await change({ limitChanges: { calls: { perPeriod: "40" } } });
    expect(doubles.lockCalls).toBe(1);
    expect(lastWritten()).toEqual({
      // The lowered cap stands. Taking it from the stale read would have
      // restored 2,000 USD of authority nobody asked for.
      amount: { ...AMOUNT, perPeriod: "500000000" },
      calls: { perPeriod: "40", period: "weekly", currencyOrUnit: "calls" },
    });
  });

  // The lost update the finding describes: one operator lowers the amount cap,
  // another changes the calls cap, and both changes must stand.
  it("keeps both changes when two operators change different measures", async () => {
    await change({
      limitChanges: { amount: { perPeriod: "500000000" } },
    });
    await change({ limitChanges: { calls: { perPeriod: "40" } } });
    expect(lastWritten()).toEqual({
      amount: { ...AMOUNT, perPeriod: "500000000" },
      calls: { perPeriod: "40", period: "weekly", currencyOrUnit: "calls" },
    });
  });

  it("keeps a measure the change does not name (first depth)", async () => {
    await change({
      limitChanges: {
        rows: {
          perCall: "50",
          perPeriod: "1000",
          period: "monthly",
          currencyOrUnit: "rows",
        },
      },
    });
    expect(lastWritten()).toEqual({
      amount: AMOUNT,
      calls: CALLS,
      rows: {
        perCall: "50",
        perPeriod: "1000",
        period: "monthly",
        currencyOrUnit: "rows",
      },
    });
  });

  it("keeps a field the change does not carry (second depth)", async () => {
    await change({ limitChanges: { amount: { perPeriod: "900000000" } } });
    expect(lastWritten().amount).toEqual({
      // The per-call bound, the window and the currency all stand: only the
      // figure named was changed. Dropping the per-call bound would be
      // unbounded authority for that sublimit.
      perCall: "250000000",
      perPeriod: "900000000",
      period: "monthly",
      currencyOrUnit: "USD",
    });
  });

  it("replaces the whole record when a caller sends limits", async () => {
    await change({
      limits: {
        rows: {
          perPeriod: "100",
          period: "daily",
          currencyOrUnit: "rows",
        },
      },
    });
    // Replacement is how a bound is deleted, and it stays exactly that for a
    // caller holding the whole record.
    expect(lastWritten()).toEqual({
      rows: { perPeriod: "100", period: "daily", currencyOrUnit: "rows" },
    });
  });

  it("refuses limits and limitChanges together, at the contract (negative)", () => {
    expect(() =>
      mandateLimitsUpdate.input.parse({
        mandateId: "mnd_1",
        limits: {
          rows: { perPeriod: "1", period: "daily", currencyOrUnit: "rows" },
        },
        limitChanges: { rows: { perPeriod: "2" } },
      }),
    ).toThrow(/limits or limitChanges/);
  });

  it("refuses a change that names no field (negative)", () => {
    expect(() =>
      mandateLimitsUpdate.input.parse({
        mandateId: "mnd_1",
        limitChanges: { rows: {} },
      }),
    ).toThrow();
  });

  it("writes nothing when the mandate has already ended (negative)", async () => {
    doubles.locked.status = "revoked";
    await expect(
      change({ limitChanges: { calls: { perPeriod: "40" } } }),
    ).rejects.toSatisfy(
      (e: unknown) => isHandlerError(e) && e.reason === "mandate_ended",
    );
    expect(doubles.written).toHaveLength(0);
  });

  // Status can still read active between exclusive validTo and the hourly
  // expiry job. Without this refusal an operator could push validTo forward
  // and reopen authority enforcement had already stopped honouring.
  it("writes nothing when active status outlives exclusive validTo (negative)", async () => {
    doubles.locked.status = "active";
    doubles.locked.validTo = new Date("2020-01-01T00:00:00.000Z");
    await expect(
      change({
        validTo: "2028-01-01T00:00:00.000Z",
        limitChanges: { calls: { perPeriod: "40" } },
      }),
    ).rejects.toSatisfy(
      (e: unknown) => isHandlerError(e) && e.reason === "mandate_ended",
    );
    expect(doubles.written).toHaveLength(0);
  });

  // The periodKey the ledger already wrote stays under the old window. Renaming
  // the window while that draw is open would make readAuthority and reserve see
  // an empty balance and grant the ceiling again.
  it("refuses a period rename while the measure is drawn (negative)", async () => {
    doubles.drawn = true;
    await expect(
      change({
        limitChanges: { amount: { period: "daily" } },
      }),
    ).rejects.toSatisfy(
      (e: unknown) => isHandlerError(e) && e.reason === "period_drawn",
    );
    expect(doubles.written).toHaveLength(0);
  });

  it("renames the period when the current window holds no draw", async () => {
    doubles.drawn = false;
    await change({
      limitChanges: { amount: { period: "daily" } },
    });
    expect(lastWritten().amount).toEqual({
      ...AMOUNT,
      period: "daily",
    });
  });

  // A reservation parked before midnight keeps the old day's periodKey. After
  // the window rolls, hasDrawnInCurrentPeriod sees an empty new day and would
  // allow the rename; the open-reservation check must still refuse.
  it("refuses a period rename while a reservation is open under an older key", async () => {
    doubles.drawn = false;
    doubles.openReservation = true;
    await expect(
      change({
        limitChanges: { amount: { period: "weekly" } },
      }),
    ).rejects.toSatisfy(
      (e: unknown) => isHandlerError(e) && e.reason === "period_drawn",
    );
    expect(doubles.written).toHaveLength(0);
  });

  // A Monday settle stays under Monday's daily key. After midnight Tuesday the
  // current-window check queries Tuesday only and open-reservation ignores
  // settled rows; the overlapping-settlement check must still refuse a
  // daily-to-weekly rename that would hide Monday inside the week.
  it("refuses a period rename while a settlement overlaps the destination window", async () => {
    doubles.drawn = false;
    doubles.openReservation = false;
    doubles.overlappingSettlement = true;
    await expect(
      change({
        limitChanges: { amount: { period: "weekly" } },
      }),
    ).rejects.toSatisfy(
      (e: unknown) => isHandlerError(e) && e.reason === "period_drawn",
    );
    expect(doubles.written).toHaveLength(0);
  });
});

describe("assertPeriodChangeAllowed", () => {
  const tx = {} as Parameters<typeof assertPeriodChangeAllowed>[0];
  const mandateId = "11111111-1111-4111-8111-111111111111";

  it("refuses when the current window still holds a draw", async () => {
    doubles.drawn = true;
    await expect(
      assertPeriodChangeAllowed(
        tx,
        mandateId,
        { amount: AMOUNT },
        { amount: { ...AMOUNT, period: "daily" } },
      ),
    ).rejects.toSatisfy(
      (e: unknown) => isHandlerError(e) && e.reason === "period_drawn",
    );
  });

  it("refuses when a reservation is open under any period key", async () => {
    doubles.drawn = false;
    doubles.openReservation = true;
    await expect(
      assertPeriodChangeAllowed(
        tx,
        mandateId,
        { amount: AMOUNT },
        { amount: { ...AMOUNT, period: "daily" } },
      ),
    ).rejects.toSatisfy(
      (e: unknown) => isHandlerError(e) && e.reason === "period_drawn",
    );
  });

  it("refuses when a settlement overlaps the destination window", async () => {
    doubles.drawn = false;
    doubles.openReservation = false;
    doubles.overlappingSettlement = true;
    await expect(
      assertPeriodChangeAllowed(
        tx,
        mandateId,
        { amount: { ...AMOUNT, period: "daily" } },
        { amount: { ...AMOUNT, period: "weekly" } },
      ),
    ).rejects.toSatisfy(
      (e: unknown) => isHandlerError(e) && e.reason === "period_drawn",
    );
  });

  it("allows a figure change that keeps the window, and a rename with nothing drawn", async () => {
    doubles.drawn = true;
    await expect(
      assertPeriodChangeAllowed(
        tx,
        mandateId,
        { amount: AMOUNT },
        { amount: { ...AMOUNT, perPeriod: "500000000" } },
      ),
    ).resolves.toBeUndefined();
    doubles.drawn = false;
    doubles.openReservation = false;
    doubles.overlappingSettlement = false;
    await expect(
      assertPeriodChangeAllowed(
        tx,
        mandateId,
        { amount: AMOUNT },
        { amount: { ...AMOUNT, period: "daily" } },
      ),
    ).resolves.toBeUndefined();
  });
});

describe("assertKindChangeAllowed", () => {
  const tx = {} as Parameters<typeof assertKindChangeAllowed>[0];
  const mandateId = "11111111-1111-4111-8111-111111111111";
  const legacy = new Set<string>();

  it("refuses when `before` holds the measure and the current window still has authority drawn under the old kind", async () => {
    doubles.drawn = true;
    await expect(
      assertKindChangeAllowed(
        tx,
        mandateId,
        { amount: { ...AMOUNT, kind: "money" } },
        { amount: { ...AMOUNT, kind: "count" } },
        legacy,
      ),
    ).rejects.toSatisfy(
      (e: unknown) => isHandlerError(e) && e.reason === "measure_kind_drawn",
    );
  });

  // A whole-record `limits` replacement can delete a measure while the
  // ledger still holds movements for it; a later call can re-add the same
  // measure under a different kind with no `before` entry to compare
  // against. `lastLedgerKind` is the fallback for exactly that gap.
  it("refuses a re-added measure absent from `before` when the ledger's last stamp disagrees and authority is still drawn", async () => {
    doubles.drawn = true;
    doubles.lastLedgerKind = "money";
    await expect(
      assertKindChangeAllowed(
        tx,
        mandateId,
        {},
        { amount: { ...AMOUNT, kind: "count" } },
        legacy,
      ),
    ).rejects.toSatisfy(
      (e: unknown) => isHandlerError(e) && e.reason === "measure_kind_drawn",
    );
  });

  it("allows a re-added measure absent from `before` when the ledger has no history for it", async () => {
    doubles.drawn = true;
    doubles.lastLedgerKind = null;
    await expect(
      assertKindChangeAllowed(
        tx,
        mandateId,
        {},
        { amount: { ...AMOUNT, kind: "count" } },
        legacy,
      ),
    ).resolves.toBeUndefined();
  });

  it("allows a re-added measure absent from `before` when the ledger's last stamp already agrees with the new kind", async () => {
    doubles.drawn = true;
    doubles.lastLedgerKind = "count";
    await expect(
      assertKindChangeAllowed(
        tx,
        mandateId,
        {},
        { amount: { ...AMOUNT, kind: "count" } },
        legacy,
      ),
    ).resolves.toBeUndefined();
  });
});

describe("applyLimitChanges", () => {
  it("takes the window from the stored bound when the change names none", () => {
    expect(
      applyLimitChanges({ calls: CALLS }, { calls: { perPeriod: "40" } }),
    ).toEqual({
      // Ten calls a week must not become forty a day: the form that writes
      // this figure shows no period control, so the change says nothing about
      // the window.
      calls: { perPeriod: "40", period: "weekly", currencyOrUnit: "calls" },
    });
  });

  it("dates a bound the record does not hold yet to the day", () => {
    expect(
      applyLimitChanges(
        { amount: AMOUNT },
        { calls: { perPeriod: "40", currencyOrUnit: "calls" } },
      ).calls,
    ).toEqual({ perPeriod: "40", period: "daily", currencyOrUnit: "calls" });
  });

  it("refuses a new bound with no unit, rather than storing a partial one (negative)", () => {
    let thrown: unknown;
    try {
      applyLimitChanges({ amount: AMOUNT }, { rows: { perPeriod: "40" } });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(HandlerError);
    expect(isHandlerError(thrown) && thrown.reason).toBe("limit_incomplete");
  });
});

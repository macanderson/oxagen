/**
 * Unit tests for metering.ts — assertCanStartTurn.
 *
 * Mocks all seams so no DB or Stripe calls are made.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be hoisted before any import of ../metering
// ---------------------------------------------------------------------------

const assertOrgCanConsumeMock = vi.fn().mockResolvedValue(undefined);
vi.mock("./dunning", () => ({
  assertOrgCanConsume: assertOrgCanConsumeMock,
  BillingSuspendedError: class BillingSuspendedError extends Error {
    readonly code = "billing_suspended" as const;
    constructor() {
      super("Billing suspended");
      this.name = "BillingSuspendedError";
    }
  },
}));

const maybeAutoReloadMock = vi
  .fn()
  .mockResolvedValue({ reloaded: false, reason: "above_threshold" });
vi.mock("./autoreload", () => ({
  maybeAutoReload: maybeAutoReloadMock,
}));

const effectiveBalanceMock = vi.fn().mockResolvedValue(0n);
const consumeCreditsMock = vi.fn().mockResolvedValue({
  chargedCents: 0n,
  shortfallCents: 0n,
  balanceCents: 0n,
});
// What the org owes from a turn that outran its balance: nothing, unless a
// case says otherwise. The gate admits on the balance net of it.
const owedCreditsMock = vi.fn().mockResolvedValue(0n);
vi.mock("./credits", () => ({
  effectiveBalance: effectiveBalanceMock,
  consumeCredits: consumeCreditsMock,
  owedCredits: owedCreditsMock,
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

// ADR-053 §3: the gate's fourth step reads the org's assistant spend cap. A
// null cap means no cap, which is the neutral answer for every case below;
// the cap's own behaviour is covered in metering.test.ts.
const getOrgBillingSettingsMock = vi
  .fn()
  .mockResolvedValue({ assistantSpendCapCents: null });
vi.mock("./billing-settings", () => ({
  getOrgBillingSettings: getOrgBillingSettingsMock,
}));

const { assertCanStartTurn, InsufficientCreditsError } = await import(
  "./metering"
);

// ---------------------------------------------------------------------------
// assertCanStartTurn
// ---------------------------------------------------------------------------

describe("assertCanStartTurn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    effectiveBalanceMock.mockResolvedValue(100n);
    assertOrgCanConsumeMock.mockResolvedValue(undefined);
    maybeAutoReloadMock.mockResolvedValue({
      reloaded: false,
      reason: "above_threshold",
    });
  });

  it("resolves when org is in good standing with positive balance", async () => {
    effectiveBalanceMock.mockResolvedValue(50n);
    await expect(assertCanStartTurn("org-1")).resolves.toBeUndefined();
    expect(assertOrgCanConsumeMock).toHaveBeenCalledWith("org-1");
    expect(maybeAutoReloadMock).toHaveBeenCalledWith("org-1");
    expect(effectiveBalanceMock).toHaveBeenCalledWith("org-1");
  });

  it("throws InsufficientCreditsError when balance is zero after reload attempt", async () => {
    effectiveBalanceMock.mockResolvedValue(0n);
    await expect(assertCanStartTurn("org-2")).rejects.toBeInstanceOf(
      InsufficientCreditsError,
    );
  });

  it("throws InsufficientCreditsError when balance is negative (should not happen but guard)", async () => {
    effectiveBalanceMock.mockResolvedValue(-5n);
    await expect(assertCanStartTurn("org-3")).rejects.toBeInstanceOf(
      InsufficientCreditsError,
    );
  });

  it("propagates BillingSuspendedError from assertOrgCanConsume", async () => {
    const { BillingSuspendedError } = await import("./dunning");
    assertOrgCanConsumeMock.mockRejectedValue(new BillingSuspendedError(null));
    await expect(assertCanStartTurn("org-4")).rejects.toBeInstanceOf(
      BillingSuspendedError,
    );
    // auto-reload and balance check must NOT be called when dunning rejects
    expect(effectiveBalanceMock).not.toHaveBeenCalled();
  });

  it("continues past auto-reload failure and still checks balance", async () => {
    maybeAutoReloadMock.mockRejectedValue(new Error("Stripe timeout"));
    effectiveBalanceMock.mockResolvedValue(10n);
    // Should NOT throw — error is swallowed; balance check passes
    await expect(assertCanStartTurn("org-5")).resolves.toBeUndefined();
    expect(effectiveBalanceMock).toHaveBeenCalledWith("org-5");
  });

  it("throws InsufficientCreditsError when auto-reload fails AND balance is zero", async () => {
    maybeAutoReloadMock.mockRejectedValue(new Error("Stripe timeout"));
    effectiveBalanceMock.mockResolvedValue(0n);
    await expect(assertCanStartTurn("org-6")).rejects.toBeInstanceOf(
      InsufficientCreditsError,
    );
  });

  // #2976: the reload already read the balance when it granted nothing, so the
  // gate reuses that read rather than scanning the ledger a second time.
  it("reuses the balance the reload read when it granted nothing", async () => {
    maybeAutoReloadMock.mockResolvedValue({
      reloaded: false,
      reason: "balance_above_threshold",
      balanceCents: 40n,
    });
    effectiveBalanceMock.mockResolvedValue(0n);
    await expect(assertCanStartTurn("org-7")).resolves.toBeUndefined();
    expect(effectiveBalanceMock).not.toHaveBeenCalled();
  });

  it("refuses on the reused balance when it is spent", async () => {
    maybeAutoReloadMock.mockResolvedValue({
      reloaded: false,
      reason: "reloaded_recently",
      balanceCents: 30n,
    });
    owedCreditsMock.mockResolvedValueOnce(30n);
    await expect(assertCanStartTurn("org-8")).rejects.toBeInstanceOf(
      InsufficientCreditsError,
    );
    expect(effectiveBalanceMock).not.toHaveBeenCalled();
  });

  it("reads the balance again after a reload granted credits", async () => {
    maybeAutoReloadMock.mockResolvedValue({
      reloaded: true,
      amountCents: 2000,
      // A stale pre-grant read must never stand in for the new balance.
      balanceCents: 0n,
    });
    effectiveBalanceMock.mockResolvedValue(2000n);
    await expect(assertCanStartTurn("org-9")).resolves.toBeUndefined();
    expect(effectiveBalanceMock).toHaveBeenCalledTimes(1);
    expect(effectiveBalanceMock).toHaveBeenCalledWith("org-9");
  });
});

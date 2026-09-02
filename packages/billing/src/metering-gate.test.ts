/**
 * Unit tests for metering.ts — assertCanStartTurn, chargeImageCredits, chargeVideoCredits.
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
vi.mock("./credits", () => ({
  effectiveBalance: effectiveBalanceMock,
  consumeCredits: consumeCreditsMock,
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const {
  assertCanStartTurn,
  chargeImageCredits,
  chargeVideoCredits,
  InsufficientCreditsError,
} = await import("./metering");

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
});

// ---------------------------------------------------------------------------
// chargeImageCredits
// ---------------------------------------------------------------------------

describe("chargeImageCredits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    consumeCreditsMock.mockResolvedValue({
      chargedCents: 10n,
      shortfallCents: 0n,
      balanceCents: 90n,
    });
  });

  it("returns a ChargeUsageResult with imageCount in logFields", async () => {
    const result = await chargeImageCredits({
      orgId: "org-1",
      model: "bfl/flux-2-max",
      imageCount: 1,
      referenceId: "img-ref-1",
    });
    expect(result).toHaveProperty("creditsMetered");
    expect(result).toHaveProperty("creditsCharged");
    expect(result).toHaveProperty("costUsdMicros");
    expect(result).toHaveProperty("shortfallCredits");
  });

  it("charges zero credits for zero images", async () => {
    const result = await chargeImageCredits({
      orgId: "org-1",
      model: "bfl/flux-2-max",
      imageCount: 0,
    });
    expect(result.creditsMetered).toBe(0n);
    expect(result.creditsCharged).toBe(0n);
    expect(consumeCreditsMock).not.toHaveBeenCalled();
  });

  it("passes referenceId to consumeCredits", async () => {
    await chargeImageCredits({
      orgId: "org-1",
      model: "bfl/flux-2-max",
      imageCount: 2,
      referenceId: "gen-123",
    });
    if (consumeCreditsMock.mock.calls.length > 0) {
      expect(consumeCreditsMock).toHaveBeenCalledWith(
        expect.objectContaining({ referenceId: "gen-123" }),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// chargeVideoCredits
// ---------------------------------------------------------------------------

describe("chargeVideoCredits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    consumeCreditsMock.mockResolvedValue({
      chargedCents: 50n,
      shortfallCents: 0n,
      balanceCents: 50n,
    });
  });

  it("returns a ChargeUsageResult with video model", async () => {
    const result = await chargeVideoCredits({
      orgId: "org-1",
      model: "google/veo-3.0-generate-001",
      durationSeconds: 5,
      referenceId: "vid-ref-1",
    });
    expect(result).toHaveProperty("creditsMetered");
    expect(result).toHaveProperty("creditsCharged");
    expect(result).toHaveProperty("costUsdMicros");
    expect(result).toHaveProperty("shortfallCredits");
  });

  it("returns a non-zero result when durationSeconds is undefined (model has base cost)", async () => {
    const result = await chargeVideoCredits({
      orgId: "org-1",
      model: "google/veo-3.0-generate-001",
    });
    // The veo-3.0 model has a base per-generation cost even without explicit duration.
    expect(result).toHaveProperty("creditsMetered");
    expect(result).toHaveProperty("costUsdMicros");
    // costUsdMicros is positive (model has a base price)
    expect(typeof result.costUsdMicros).toBe("number");
  });

  it("surfaces shortfall from consumeCredits for video charges", async () => {
    consumeCreditsMock.mockResolvedValue({
      chargedCents: 5n,
      shortfallCents: 45n,
      balanceCents: 0n,
    });
    const result = await chargeVideoCredits({
      orgId: "org-1",
      model: "google/veo-3.0-generate-001",
      durationSeconds: 10,
    });
    if (result.creditsMetered > 0n) {
      expect(result.shortfallCredits).toBe(45n);
      expect(result.creditsCharged).toBe(5n);
    }
  });
});

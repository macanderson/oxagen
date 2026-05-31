/**
 * Unit tests for the cost meter / gate (packages/billing/src/metering.ts).
 *
 * Mocks two seams:
 *  - `../credits.js` `effectiveBalance` — hasCreditBalance now reads from lots
 *    (lazy expiry) rather than the cached credit_balances mirror.
 *  - `../credits.js` `consumeCredits` — the atomic clamped debit (its own
 *    lot-based logic is tested in consume-credits.test.ts).
 *
 * We verify the meter's arithmetic and that it delegates correctly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// consumeCredits + effectiveBalance are both in ../credits.js
const consumeState: { chargedCents: bigint; shortfallCents: bigint } = {
  chargedCents: 0n,
  shortfallCents: 0n,
};
const consumeCredits = vi.fn(async () => ({ ...consumeState, balanceCents: 0n }));

const effectiveBalanceState: { value: bigint } = { value: 0n };
const effectiveBalance = vi.fn(async (_orgId: string) => effectiveBalanceState.value);

vi.mock("../credits.js", () => ({ consumeCredits, effectiveBalance }));

const { chargeUsageCredits, hasCreditBalance, meterCreditsForUsage } = await import("../metering.js");

// Markup solved for the default 65% target — passed explicitly so these tests
// don't depend on env. ($0.06 cost × 3.319 / $0.01 = 19.9 → ceil 20 credits.)
const MARKUP = 3.319;
const sonnetCall = { model: "claude-sonnet-4-6", inputTokens: 10_000, outputTokens: 2_000 };

describe("meterCreditsForUsage", () => {
  it("rounds credits up from provider cost × markup", () => {
    expect(meterCreditsForUsage(sonnetCall, { markup: MARKUP })).toBe(20n);
  });

  it("returns 0 credits for a zero-cost call", () => {
    expect(
      meterCreditsForUsage({ model: "claude-sonnet-4-6", inputTokens: 0, outputTokens: 0 }, { markup: MARKUP }),
    ).toBe(0n);
  });
});

describe("chargeUsageCredits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    consumeState.chargedCents = 0n;
    consumeState.shortfallCents = 0n;
  });

  it("meters the call and delegates the full debit to consumeCredits", async () => {
    consumeState.chargedCents = 20n;
    const result = await chargeUsageCredits({ orgId: "org-1", referenceId: "msg-1", markup: MARKUP, ...sonnetCall });

    expect(result.creditsMetered).toBe(20n);
    expect(result.creditsCharged).toBe(20n);
    expect(result.shortfallCredits).toBe(0n);
    expect(result.costUsdMicros).toBe(60_000);
    expect(consumeCredits).toHaveBeenCalledWith({
      orgId: "org-1",
      requestedCents: 20n,
      reason: "consume_token_overage",
      referenceType: "token_usage",
      referenceId: "msg-1",
    });
  });

  it("surfaces the clamp/shortfall reported by consumeCredits", async () => {
    consumeState.chargedCents = 5n;
    consumeState.shortfallCents = 15n;
    const result = await chargeUsageCredits({ orgId: "org-1", markup: MARKUP, ...sonnetCall });

    expect(result.creditsMetered).toBe(20n);
    expect(result.creditsCharged).toBe(5n);
    expect(result.shortfallCredits).toBe(15n);
    expect(consumeCredits).toHaveBeenCalledWith(expect.objectContaining({ requestedCents: 20n }));
  });

  it("never calls consumeCredits for a zero-cost call", async () => {
    const result = await chargeUsageCredits({
      orgId: "org-1",
      markup: MARKUP,
      model: "claude-sonnet-4-6",
      inputTokens: 0,
      outputTokens: 0,
    });

    expect(result.creditsMetered).toBe(0n);
    expect(result.creditsCharged).toBe(0n);
    expect(consumeCredits).not.toHaveBeenCalled();
  });
});

describe("hasCreditBalance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    effectiveBalanceState.value = 0n;
  });

  it("is true when the effective balance is positive", async () => {
    effectiveBalanceState.value = 10n;
    expect(await hasCreditBalance("org-1")).toBe(true);
    expect(effectiveBalance).toHaveBeenCalledWith("org-1");
  });

  it("is false at zero effective balance", async () => {
    effectiveBalanceState.value = 0n;
    expect(await hasCreditBalance("org-1")).toBe(false);
  });

  it("is false when effectiveBalance returns 0 (no lots or all expired)", async () => {
    effectiveBalanceState.value = 0n;
    expect(await hasCreditBalance("org-1")).toBe(false);
  });
});

/**
 * Unit tests for the cost meter / gate (packages/billing/src/metering.ts).
 *
 * Mocks two seams: `@oxagen/database` (the read-only balance check) and
 * `../credits.js` `consumeCredits` (the atomic clamped debit — its own
 * row-locking/clamp behaviour is tested in credits.test.ts). Here we verify the
 * meter's arithmetic and that it delegates the debit with the right arguments.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const dbState: { balance: bigint | null } = { balance: null };
const findFirst = vi.fn(async () => (dbState.balance === null ? undefined : { balanceCents: dbState.balance }));

vi.mock("@oxagen/database", () => ({
  db: () => ({ query: { creditBalances: { findFirst } } }),
  schema: { creditBalances: { orgId: "org_id_col" } },
}));

// consumeCredits is mocked to echo a configurable charge/shortfall so we can
// assert the meter delegates correctly and maps the result back.
const consumeState: { chargedCents: bigint; shortfallCents: bigint } = { chargedCents: 0n, shortfallCents: 0n };
const consumeCredits = vi.fn(async () => ({ ...consumeState, balanceCents: 0n }));
vi.mock("../credits.js", () => ({ consumeCredits }));

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
    expect(meterCreditsForUsage({ model: "claude-sonnet-4-6", inputTokens: 0, outputTokens: 0 }, { markup: MARKUP })).toBe(
      0n,
    );
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
    dbState.balance = null;
  });

  it("is true when the balance is positive", async () => {
    dbState.balance = 10n;
    expect(await hasCreditBalance("org-1")).toBe(true);
  });

  it("is false at zero balance", async () => {
    dbState.balance = 0n;
    expect(await hasCreditBalance("org-1")).toBe(false);
  });

  it("is false when no balance row exists", async () => {
    dbState.balance = null;
    expect(await hasCreditBalance("org-1")).toBe(false);
  });
});

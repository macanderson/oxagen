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
import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import type { SQL } from "drizzle-orm";
import { CREDIT_REASONS } from "./constants";

// consumeCredits + effectiveBalance are both in ../credits.js
const consumeState: { chargedCents: bigint; shortfallCents: bigint } = {
  chargedCents: 0n,
  shortfallCents: 0n,
};
const consumeCredits = vi.fn(async () => ({
  ...consumeState,
  balanceCents: 0n,
  carryMicroCents: 0n,
}));

const effectiveBalanceState: { value: bigint } = { value: 0n };
const effectiveBalance = vi.fn(
  async (_orgId: string) => effectiveBalanceState.value,
);

vi.mock("./credits", () => ({ consumeCredits, effectiveBalance }));

// ── ADR-053 §3 seams: the assistant spend cap ────────────────────────────────
// assertCanStartTurn's first three steps (dunning, auto-reload, balance) are
// mocked to admit, so the tests below isolate step 4. The cap itself reads the
// org's settings row and sums the ledger through withTenantDb.
const assertOrgCanConsume = vi.fn(async (_orgId: string) => undefined);
vi.mock("./dunning", () => ({
  assertOrgCanConsume,
  BillingSuspendedError: class BillingSuspendedError extends Error {
    readonly code = "billing_suspended" as const;
    constructor() {
      super("Billing suspended");
      this.name = "BillingSuspendedError";
    }
  },
}));

const maybeAutoReload = vi.fn(async (_orgId: string) => ({
  reloaded: false,
  reason: "above_threshold",
}));
vi.mock("./autoreload", () => ({ maybeAutoReload }));

const settingsState: { assistantSpendCapCents: number | null } = {
  assistantSpendCapCents: null,
};
const getOrgBillingSettings = vi.fn(async (orgId: string) => ({
  orgId,
  assistantSpendCapCents: settingsState.assistantSpendCapCents,
}));
vi.mock("./billing-settings", () => ({ getOrgBillingSettings }));

// The ledger sum: `tx.select({ spent }).from(creditLedger).where(...)` resolves
// to one row whose `spent` is the driver's string rendering of the SUM.
const ledgerState: { spent: string } = { spent: "0" };
const ledgerWhere = vi.fn(async (_where: unknown) => [
  { spent: ledgerState.spent },
]);
const ledgerFrom = vi.fn((_table: unknown) => ({ where: ledgerWhere }));
const ledgerSelect = vi.fn((_fields: unknown) => ({ from: ledgerFrom }));
const withTenantDb = vi.fn(
  async (fn: (tx: { select: typeof ledgerSelect }) => Promise<unknown>) =>
    fn({ select: ledgerSelect }),
);
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb };
});

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const {
  AssistantSpendCapError,
  assertCanStartTurn,
  assertUnderAssistantSpendCap,
  assistantSpendThisMonth,
  assistantSpendWindowStart,
  chargeUsageCredits,
  hasCreditBalance,
  meterCreditsForUsage,
} = await import("./metering");
const { PgDialect } = await import("drizzle-orm/pg-core");

// Markup solved for the default 65% target — passed explicitly so these tests
// don't depend on env. ($0.06 cost × 3.319 / $0.01 = 19.9 → ceil 20 credits.)
const MARKUP = 3.319;
const sonnetCall = {
  model: "claude-sonnet-5",
  inputTokens: 10_000,
  outputTokens: 2_000,
};

describe("meterCreditsForUsage", () => {
  it("rounds credits up from provider cost × markup", () => {
    expect(meterCreditsForUsage(sonnetCall, { markup: MARKUP })).toBe(20n);
  });

  it("returns 0 credits for a zero-cost call", () => {
    expect(
      meterCreditsForUsage(
        { model: "claude-sonnet-5", inputTokens: 0, outputTokens: 0 },
        { markup: MARKUP },
      ),
    ).toBe(0n);
  });

  // ── cache-aware metering witnesses ────────────────────────────────────────
  // These prove the billed credit amount actually reflects the cache split — the
  // whole point of the feature — not just that the cost function returns a number.

  it("bills a cache-read-heavy call FEWER credits than the same call uncached", () => {
    // Same 10k inclusive input, but 8k served from cache (0.1x rate) → cheaper.
    const uncached = meterCreditsForUsage(sonnetCall, { markup: MARKUP });
    const cached = meterCreditsForUsage(
      { ...sonnetCall, cachedTokens: 8_000 },
      { markup: MARKUP },
    );
    expect(cached).toBeLessThan(uncached);
  });

  it("bills a cache-write-heavy call MORE credits than treating those tokens as fresh input", () => {
    // 8k of the input are cache writes (1.25x premium on Anthropic), so the
    // call must bill MORE than the identical call that counts those tokens
    // as fresh 1x input.
    const asFresh = meterCreditsForUsage(sonnetCall, { markup: MARKUP });
    const withWrites = meterCreditsForUsage(
      { ...sonnetCall, cacheWriteTokens: 8_000 },
      { markup: MARKUP },
    );
    expect(withWrites).toBeGreaterThan(asFresh);
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
    const result = await chargeUsageCredits({
      reason: CREDIT_REASONS.CONSUME_ASSISTANT_TOKENS,
      orgId: "org-1",
      referenceId: "msg-1",
      markup: MARKUP,
      ...sonnetCall,
    });

    expect(result.creditsMetered).toBe(20n);
    expect(result.creditsCharged).toBe(20n);
    expect(result.shortfallCredits).toBe(0n);
    expect(result.costUsdMicros).toBe(60_000);
    // The meter hands over MICRO-credits — 19.914 of a credit, exact — and
    // consumeCredits decides what whole credits that becomes. Rounding here
    // instead is what charged a fraction of a credit as a whole one (#1413).
    expect(consumeCredits).toHaveBeenCalledWith({
      orgId: "org-1",
      requestedMicroCents: 19_914_000n,
      reason: "consume_assistant_tokens",
      referenceType: "token_usage",
      referenceId: "msg-1",
    });
  });

  it("surfaces the clamp/shortfall reported by consumeCredits", async () => {
    consumeState.chargedCents = 5n;
    consumeState.shortfallCents = 15n;
    const result = await chargeUsageCredits({
      reason: CREDIT_REASONS.CONSUME_ASSISTANT_TOKENS,
      orgId: "org-1",
      markup: MARKUP,
      ...sonnetCall,
    });

    expect(result.creditsMetered).toBe(20n);
    expect(result.creditsCharged).toBe(5n);
    expect(result.shortfallCredits).toBe(15n);
    expect(consumeCredits).toHaveBeenCalledWith(
      expect.objectContaining({ requestedMicroCents: 19_914_000n }),
    );
  });

  it("never calls consumeCredits for a zero-cost call", async () => {
    const result = await chargeUsageCredits({
      reason: CREDIT_REASONS.CONSUME_ASSISTANT_TOKENS,
      orgId: "org-1",
      markup: MARKUP,
      model: "claude-sonnet-5",
      inputTokens: 0,
      outputTokens: 0,
    });

    expect(result.creditsMetered).toBe(0n);
    expect(result.creditsCharged).toBe(0n);
    expect(consumeCredits).not.toHaveBeenCalled();
  });

  // ADR-053 §3: the in-app agent's platform-paid tokens are their own ledger
  // line, never folded into the retired overage reason.
  it("forwards the caller's ledger reason to consumeCredits", async () => {
    consumeState.chargedCents = 20n;
    await chargeUsageCredits({
      orgId: "org-1",
      referenceId: "msg-1",
      markup: MARKUP,
      reason: "consume_assistant_tokens",
      ...sonnetCall,
    });
    expect(consumeCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        reason: "consume_assistant_tokens",
        referenceType: "token_usage",
      }),
    );
  });

  // The reason used to default to consume_token_overage, which ADR-052 retired
  // and ADR-053 says must not be repurposed — and the assistant spend cap sums
  // consume_assistant_tokens alone, so a defaulted debit was invisible to the
  // cap meant to bound it. It is a required field now, so no call can fall into
  // the retired reason by omission; this asserts the value is passed through
  // rather than substituted.
  it("never substitutes the retired overage reason for the caller's", async () => {
    consumeState.chargedCents = 20n;
    await chargeUsageCredits({
      orgId: "org-1",
      markup: MARKUP,
      reason: CREDIT_REASONS.CONSUME_ASSISTANT_TOKENS,
      ...sonnetCall,
    });
    expect(consumeCredits).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: "consume_token_overage" }),
    );
    expect(consumeCredits).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "consume_assistant_tokens" }),
    );
  });
});

// ── ADR-053 §3: the assistant spend cap ──────────────────────────────────────

describe("AssistantSpendCapError", () => {
  it("carries the cap and the spend, a stable code, and a message naming both ways out", () => {
    const err = new AssistantSpendCapError(2_000, 2_150);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("AssistantSpendCapError");
    expect(err.code).toBe("assistant_spend_cap");
    expect(err.capCents).toBe(2_000);
    expect(err.spentCents).toBe(2_150);
    expect(err.message).toContain("2150 of its 2000 credits");
    expect(err.message).toMatch(/Raise the cap/);
    expect(err.message).toMatch(/your own model API key/);
  });
});

describe("assistantSpendWindowStart", () => {
  it("is the first instant of the current calendar month, in UTC", () => {
    expect(
      assistantSpendWindowStart(new Date("2026-09-15T23:59:59.999Z")),
    ).toEqual(new Date(Date.UTC(2026, 8, 1, 0, 0, 0, 0)));
  });

  it("uses the UTC month, not the local one, at a month boundary", () => {
    // 00:30 UTC on 1 October is still 30 September in every zone west of UTC;
    // the window is defined in UTC so every replica agrees on the month.
    expect(
      assistantSpendWindowStart(new Date("2026-10-01T00:30:00.000Z")),
    ).toEqual(new Date(Date.UTC(2026, 9, 1)));
    expect(
      assistantSpendWindowStart(new Date("2026-09-30T23:30:00.000Z")),
    ).toEqual(new Date(Date.UTC(2026, 8, 1)));
  });

  it("defaults to now", () => {
    const now = new Date();
    expect(assistantSpendWindowStart()).toEqual(
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    );
  });
});

describe("assistantSpendThisMonth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ledgerState.spent = "0";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads through withTenantDb so RLS stays in front of the ledger", async () => {
    await assistantSpendThisMonth("org-1");
    expect(withTenantDb).toHaveBeenCalledTimes(1);
  });

  it("returns the negated sum of consume_assistant_tokens debits as a bigint", async () => {
    ledgerState.spent = "1234";
    await expect(assistantSpendThisMonth("org-1")).resolves.toBe(1234n);
  });

  it("answers 0n when the org has no assistant debits this month", async () => {
    ledgerState.spent = "0";
    await expect(assistantSpendThisMonth("org-1")).resolves.toBe(0n);
  });

  it("sums only this org's consume_assistant_tokens rows since the UTC month start", async () => {
    await assistantSpendThisMonth("org-1");
    const dialect = new PgDialect();
    // The projection negates the SUM (debits are negative in the ledger) and
    // coalesces an empty month to 0.
    const fields = ledgerSelect.mock.calls[0]?.[0] as { spent: SQL };
    const projection = dialect.sqlToQuery(fields.spent);
    expect(projection.sql).toMatch(/COALESCE\(-SUM\(.*"delta_cents"\), 0\)/);
    // The filter: this org, this reason, from the window start onward.
    const where = ledgerWhere.mock.calls[0]?.[0] as SQL;
    const filter = dialect.sqlToQuery(where);
    expect(filter.sql).toMatch(/"org_id" = \$1/);
    expect(filter.sql).toMatch(/"reason" = \$2/);
    expect(filter.sql).toMatch(/"created_at" >= \$3/);
    // The timestamp column's driver encoding is the ISO string of the window
    // start — the first instant of September 2026, UTC.
    expect(filter.params).toEqual([
      "org-1",
      "consume_assistant_tokens",
      new Date(Date.UTC(2026, 8, 1)).toISOString(),
    ]);
  });
});

describe("assertUnderAssistantSpendCap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settingsState.assistantSpendCapCents = null;
    ledgerState.spent = "0";
  });

  it("passes without reading the ledger when the org has no cap", async () => {
    settingsState.assistantSpendCapCents = null;
    await expect(
      assertUnderAssistantSpendCap("org-1"),
    ).resolves.toBeUndefined();
    expect(getOrgBillingSettings).toHaveBeenCalledWith("org-1");
    expect(withTenantDb).not.toHaveBeenCalled();
  });

  it("passes while the month's spend is under the cap", async () => {
    settingsState.assistantSpendCapCents = 2_000;
    ledgerState.spent = "1999";
    await expect(
      assertUnderAssistantSpendCap("org-1"),
    ).resolves.toBeUndefined();
  });

  it("refuses once the month's spend reaches the cap, naming both numbers", async () => {
    settingsState.assistantSpendCapCents = 2_000;
    ledgerState.spent = "2000";
    const err = await assertUnderAssistantSpendCap("org-1").catch((e) => e);
    expect(err).toBeInstanceOf(AssistantSpendCapError);
    expect(err).toMatchObject({
      code: "assistant_spend_cap",
      capCents: 2_000,
      spentCents: 2_000,
    });
  });

  it("refuses once the spend has overshot the cap", async () => {
    settingsState.assistantSpendCapCents = 2_000;
    ledgerState.spent = "2450";
    await expect(assertUnderAssistantSpendCap("org-1")).rejects.toMatchObject({
      capCents: 2_000,
      spentCents: 2_450,
    });
  });

  it("a zero cap refuses every platform-paid turn — the opt-out for an org with no key", async () => {
    settingsState.assistantSpendCapCents = 0;
    ledgerState.spent = "0";
    await expect(assertUnderAssistantSpendCap("org-1")).rejects.toBeInstanceOf(
      AssistantSpendCapError,
    );
  });
});

describe("assertCanStartTurn — who pays decides whether the cap applies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    effectiveBalanceState.value = 100n;
    settingsState.assistantSpendCapCents = 2_000;
    ledgerState.spent = "2000"; // at the cap: the step refuses if it runs
  });

  it("skips the cap for a turn the organisation's own key pays for", async () => {
    await expect(
      assertCanStartTurn("org-1", { fundedBy: "org" }),
    ).resolves.toBeUndefined();
    expect(getOrgBillingSettings).not.toHaveBeenCalled();
    expect(withTenantDb).not.toHaveBeenCalled();
    // The credit gate itself still ran: governed tool calls consume credits
    // under ADR-052 whoever pays for tokens.
    expect(assertOrgCanConsume).toHaveBeenCalledWith("org-1");
    expect(effectiveBalance).toHaveBeenCalledWith("org-1");
  });

  it("holds a platform-funded turn to the cap", async () => {
    await expect(
      assertCanStartTurn("org-1", { fundedBy: "platform" }),
    ).rejects.toBeInstanceOf(AssistantSpendCapError);
    expect(getOrgBillingSettings).toHaveBeenCalledWith("org-1");
  });

  it("treats a turn with no stated funding as platform-funded", async () => {
    await expect(assertCanStartTurn("org-1")).rejects.toBeInstanceOf(
      AssistantSpendCapError,
    );
  });

  it("admits a platform-funded turn that is still under the cap", async () => {
    ledgerState.spent = "1999";
    await expect(assertCanStartTurn("org-1")).resolves.toBeUndefined();
  });

  it("runs the cap after the balance check, so an empty balance is reported first", async () => {
    effectiveBalanceState.value = 0n;
    const err = await assertCanStartTurn("org-1").catch((e) => e);
    expect(err).not.toBeInstanceOf(AssistantSpendCapError);
    expect(err).toMatchObject({ code: "insufficient_credits" });
    expect(getOrgBillingSettings).not.toHaveBeenCalled();
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

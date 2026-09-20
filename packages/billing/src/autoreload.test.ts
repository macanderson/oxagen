/**
 * Unit tests for autoreload.ts
 *
 * Covers:
 *  - isLowBalance: true below threshold, false above
 *  - maybeAutoReload: disabled → skip; above threshold → skip; reloaded recently → skip
 *  - maybeAutoReload: below threshold → charge → grant lot → set lastAutoReloadAt
 *  - maybeAutoReload: charge failure → returns {reloaded:false, reason}
 *  - maybeAutoReload: no stripe customer → returns {reloaded:false}
 *  - maybeAutoReload: the settings customer wins over a stale subscription one
 *  - maybeAutoReload: idempotency (reloaded within last hour)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const effectiveBalanceMock = vi.fn().mockResolvedValue(0n);
const createCreditLotMock = vi
  .fn()
  .mockResolvedValue({ lotId: "lot-1", effectiveBalanceCents: 1000n });

vi.mock("./credits", () => ({
  effectiveBalance: effectiveBalanceMock,
  createCreditLot: createCreditLotMock,
}));

const chargeOffSessionMock = vi.fn().mockResolvedValue({
  paymentIntentId: "pi_test_001",
  status: "succeeded",
  succeeded: true,
});
const getDefaultPaymentMethodIdMock = vi.fn().mockResolvedValue("pm_default");

vi.mock("./client", () => ({
  billingProvider: () => ({
    chargeOffSession: chargeOffSessionMock,
    getDefaultPaymentMethodId: getDefaultPaymentMethodIdMock,
  }),
}));

// getOrgBillingSettings — provided by sibling agent; we mock it here.
const getOrgBillingSettingsMock = vi.fn();
vi.mock("./billing-settings", () => ({
  getOrgBillingSettings: getOrgBillingSettingsMock,
}));

// DB mock.
//
// `update(...).set(...).where(...)` is awaitable AND carries `.returning()`,
// which is the shape drizzle's builder has and the shape claimReloadEpisode
// reads the episode key back through. The episode row is modelled rather than
// stubbed: a claim against an open episode hands back the key it already has,
// which is what the real statement's COALESCE does — and is the whole property
// #1420 turns on.
interface DbState {
  subRow: Record<string, unknown> | null;
  grantRow: { id: string } | null;
  grantPredicate: SQL | null;
  failClose: boolean;
  /** The org_billing_settings customer id; null leaves the column empty. */
  settingsCustomerId: string | null;
  /** Set by closeReloadEpisode; the marker that a reload actually finished. */
  lastAutoReloadAt: Date | null;
  episodeKey: string | null;
  episodeStartedAt: Date | null;
  claimCount: number;
  claimPredicates: SQL[];
  closePredicates: SQL[];
  /** What a fresh claim records as the episode's start. Tests move this. */
  now: Date;
}

function makeState(): DbState {
  return {
    subRow: null,
    grantRow: null,
    grantPredicate: null,
    failClose: false,
    settingsCustomerId: null,
    lastAutoReloadAt: null,
    episodeKey: null,
    episodeStartedAt: null,
    claimCount: 0,
    claimPredicates: [],
    closePredicates: [],
    now: new Date(),
  };
}

function makeDb(state: DbState) {
  return {
    query: {
      creditLedger: {
        findFirst: vi.fn((args: { where: SQL }) => {
          state.grantPredicate = args.where;
          return Promise.resolve(state.grantRow);
        }),
      },
      subscriptions: {
        findFirst: vi.fn(async () => state.subRow),
      },
      orgBillingSettings: {
        findFirst: vi.fn(async () => ({
          stripeCustomerId: state.settingsCustomerId,
        })),
      },
    },
    update: vi.fn(() => ({
      set: vi.fn((vals: Record<string, unknown>) => {
        return {
          where: vi.fn((predicate: SQL) => {
            if (vals["autoReloadEpisodeKey"] === null) {
              if (state.failClose) throw new Error("cleanup unavailable");
              state.closePredicates.push(predicate);
              const query = new PgDialect().sqlToQuery(predicate);
              if (query.params.includes(state.episodeKey)) {
                state.episodeKey = null;
                state.episodeStartedAt = null;
                state.lastAutoReloadAt = vals["lastAutoReloadAt"] as Date;
              }
            }
            const builder = Promise.resolve(undefined) as Promise<unknown> & {
              returning: () => Promise<unknown[]>;
            };
            builder.returning = async () => {
              state.claimPredicates.push(predicate);
              if (
                state.lastAutoReloadAt &&
                state.lastAutoReloadAt.getTime() >=
                  state.now.getTime() - 60 * 60 * 1000
              )
                return [];
              if (!state.episodeKey) {
                state.claimCount += 1;
                state.episodeKey = `episode-${state.claimCount}`;
                state.episodeStartedAt = state.now;
              }
              return [
                {
                  idempotencyKey: state.episodeKey,
                  startedAt: state.episodeStartedAt,
                },
              ];
            };
            return builder;
          }),
        };
      }),
    })),
  };
}

const dbHolder: { instance: ReturnType<typeof makeDb> | null } = {
  instance: null,
};

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
    ...real,
    db: () => dbHolder.instance,
    withTenantDb: async (fn: (tx: unknown) => unknown) => fn(dbHolder.instance),
    withSystemDb: async (fn: (tx: unknown) => unknown) => fn(dbHolder.instance),
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

// Import after mocks.
const { isLowBalance, maybeAutoReload } = await import("./autoreload");

// ---------------------------------------------------------------------------
// Default settings factory
// ---------------------------------------------------------------------------

function makeSettings(
  overrides: Partial<{
    autoReloadEnabled: boolean;
    autoReloadThresholdCents: bigint;
    autoReloadAmountCents: bigint;
    autoReloadPaymentMethodId: string | null;
    lowBalanceThresholdCents: bigint;
    lastAutoReloadAt: Date | null;
    dunningState: "active" | "grace" | "suspended";
    delinquentSince: Date | null;
    graceEndsAt: Date | null;
    suspendedAt: Date | null;
  }> = {},
) {
  return {
    orgId: "org-abc",
    autoReloadEnabled: true,
    autoReloadThresholdCents: 500n,
    autoReloadAmountCents: 2000n,
    autoReloadPaymentMethodId: null,
    lowBalanceThresholdCents: 500n,
    lastAutoReloadAt: null,
    dunningState: "active" as const,
    delinquentSince: null,
    graceEndsAt: null,
    suspendedAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("isLowBalance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const state = makeState();
    dbHolder.instance = makeDb(state);
  });

  it("returns low=true when balance < threshold", async () => {
    getOrgBillingSettingsMock.mockResolvedValue(
      makeSettings({ lowBalanceThresholdCents: 500n }),
    );
    effectiveBalanceMock.mockResolvedValue(200n);
    const result = await isLowBalance("org-abc");
    expect(result.low).toBe(true);
    expect(result.balanceCents).toBe(200);
    expect(result.thresholdCents).toBe(500);
  });

  it("returns low=false when balance >= threshold", async () => {
    getOrgBillingSettingsMock.mockResolvedValue(
      makeSettings({ lowBalanceThresholdCents: 500n }),
    );
    effectiveBalanceMock.mockResolvedValue(1000n);
    const result = await isLowBalance("org-abc");
    expect(result.low).toBe(false);
  });

  it("returns low=false when balance exactly equals threshold", async () => {
    getOrgBillingSettingsMock.mockResolvedValue(
      makeSettings({ lowBalanceThresholdCents: 500n }),
    );
    effectiveBalanceMock.mockResolvedValue(500n);
    const result = await isLowBalance("org-abc");
    expect(result.low).toBe(false);
  });

  it("forwards no db options by default (request path → RLS-enforced reads)", async () => {
    getOrgBillingSettingsMock.mockResolvedValue(
      makeSettings({ lowBalanceThresholdCents: 500n }),
    );
    effectiveBalanceMock.mockResolvedValue(200n);
    await isLowBalance("org-abc");
    expect(getOrgBillingSettingsMock).toHaveBeenCalledWith(
      "org-abc",
      undefined,
    );
    expect(effectiveBalanceMock).toHaveBeenCalledWith("org-abc", undefined);
  });

  it("forwards { system: true } to both reads for trusted cron use (no tenant scope)", async () => {
    // Regression: the billing.dunning-sweep cron runs with NO active tenant
    // scope, so its billing reads must go through withSystemDb. isLowBalance
    // must thread the system flag down to getOrgBillingSettings AND
    // effectiveBalance, or the withTenantDb inside them throws TenantScopeError.
    getOrgBillingSettingsMock.mockResolvedValue(
      makeSettings({ lowBalanceThresholdCents: 500n }),
    );
    effectiveBalanceMock.mockResolvedValue(200n);
    const result = await isLowBalance("org-abc", { system: true });
    expect(result.low).toBe(true);
    expect(getOrgBillingSettingsMock).toHaveBeenCalledWith("org-abc", {
      system: true,
    });
    expect(effectiveBalanceMock).toHaveBeenCalledWith("org-abc", {
      system: true,
    });
  });
});

describe("maybeAutoReload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chargeOffSessionMock.mockResolvedValue({
      paymentIntentId: "pi_test_001",
      status: "succeeded",
      succeeded: true,
    });
    getDefaultPaymentMethodIdMock.mockResolvedValue("pm_default");
    createCreditLotMock.mockResolvedValue({
      lotId: "lot-1",
      effectiveBalanceCents: 3000n,
    });
  });

  it.each([true, false])(
    "verifies a competing grant before clearing the episode: %s",
    async (exists) => {
      const state = makeState();
      state.subRow = { stripeCustomerId: "cus_test" };
      state.grantRow = exists ? { id: "ledger-1" } : null;
      dbHolder.instance = makeDb(state);
      getOrgBillingSettingsMock.mockResolvedValue(makeSettings());
      effectiveBalanceMock.mockResolvedValue(100n);
      createCreditLotMock.mockRejectedValueOnce({ cause: { code: "23505" } });
      const result = await maybeAutoReload("org-abc");
      expect(result.reloaded).toBe(exists);
      expect(state.episodeKey === null).toBe(exists);
      if (!state.grantPredicate)
        throw new Error("Expected a scoped ledger lookup");
      const query = new PgDialect().sqlToQuery(state.grantPredicate);
      expect(query.sql).toContain('"org_id"');
      expect(query.sql).toContain('"delta_cents"');
      expect(query.sql).toContain('"reason"');
      expect(query.params).toContain("org-abc");
      const referenceId = "d1823e31-77e3-3e46-d723-49b4c6f9f110";
      expect(query.params).toContain(referenceId);
      expect(query.params).not.toContain("pi_test_001");
      expect(createCreditLotMock).toHaveBeenCalledWith(
        expect.objectContaining({ referenceId }),
      );
      expect(query.params).toContain("payment_intent");
      expect(query.params).toContain("grant_auto_reload");
      expect(query.params.map(String)).toContain("2000");
      expect(chargeOffSessionMock).toHaveBeenCalledTimes(1);
    },
  );

  it("reports granted credits when episode cleanup fails", async () => {
    const state = makeState();
    state.subRow = { stripeCustomerId: "cus_test" };
    state.failClose = true;
    dbHolder.instance = makeDb(state);
    getOrgBillingSettingsMock.mockResolvedValue(makeSettings());
    effectiveBalanceMock.mockResolvedValue(100n);
    const result = await maybeAutoReload("org-abc");
    expect(result.reloaded).toBe(true);
    expect(state.episodeKey).not.toBeNull();
    expect(createCreditLotMock).toHaveBeenCalledTimes(1);
  });

  it("skips when auto-reload is disabled", async () => {
    const state = makeState();
    state.subRow = { stripeCustomerId: "cus_test" };
    dbHolder.instance = makeDb(state);
    getOrgBillingSettingsMock.mockResolvedValue(
      makeSettings({ autoReloadEnabled: false }),
    );
    effectiveBalanceMock.mockResolvedValue(200n);

    const result = await maybeAutoReload("org-abc");
    expect(result.reloaded).toBe(false);
    expect(result.reason).toBe("auto_reload_disabled");
    expect(chargeOffSessionMock).not.toHaveBeenCalled();
  });

  it("skips when balance is above threshold", async () => {
    const state = makeState();
    dbHolder.instance = makeDb(state);
    getOrgBillingSettingsMock.mockResolvedValue(
      makeSettings({ autoReloadThresholdCents: 500n }),
    );
    effectiveBalanceMock.mockResolvedValue(600n);

    const result = await maybeAutoReload("org-abc");
    expect(result.reloaded).toBe(false);
    expect(result.reason).toBe("balance_above_threshold");
  });

  it("skips when reloaded within the last hour", async () => {
    const state = makeState();
    dbHolder.instance = makeDb(state);
    const recentReload = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago
    getOrgBillingSettingsMock.mockResolvedValue(
      makeSettings({
        autoReloadThresholdCents: 500n,
        lastAutoReloadAt: recentReload,
      }),
    );
    effectiveBalanceMock.mockResolvedValue(100n);

    const result = await maybeAutoReload("org-abc");
    expect(result.reloaded).toBe(false);
    expect(result.reason).toBe("reloaded_recently");
    expect(chargeOffSessionMock).not.toHaveBeenCalled();
  });

  it("skips when no stripe customer found", async () => {
    const state = makeState();
    state.subRow = null; // no subscription
    dbHolder.instance = makeDb(state);
    getOrgBillingSettingsMock.mockResolvedValue(
      makeSettings({ autoReloadThresholdCents: 500n }),
    );
    effectiveBalanceMock.mockResolvedValue(100n);

    const result = await maybeAutoReload("org-abc");
    expect(result.reloaded).toBe(false);
    expect(result.reason).toBe("no_stripe_customer");
    expect(chargeOffSessionMock).not.toHaveBeenCalled();
  });

  it("charges off-session and grants credit lot on success", async () => {
    const state = makeState();
    state.subRow = { stripeCustomerId: "cus_test_001" };
    dbHolder.instance = makeDb(state);
    getOrgBillingSettingsMock.mockResolvedValue(
      makeSettings({
        autoReloadThresholdCents: 500n,
        autoReloadAmountCents: 2000n,
        autoReloadPaymentMethodId: "pm_saved_001",
      }),
    );
    effectiveBalanceMock.mockResolvedValue(100n);

    const result = await maybeAutoReload("org-abc");

    expect(result.reloaded).toBe(true);
    expect(result.amountCents).toBe(2000);
    expect(chargeOffSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: "cus_test_001",
        amountCents: 2000,
        paymentMethodId: "pm_saved_001",
      }),
    );
    expect(createCreditLotMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-abc",
        amountCents: 2000n,
        source: "purchase",
        reason: "grant_auto_reload",
      }),
    );
    // The episode is finished: the reload is stamped and the key released.
    expect(state.lastAutoReloadAt).toBeInstanceOf(Date);
    expect(state.episodeKey).toBeNull();
  });

  it("charges the settings customer, not a stale id left on a subscription row", async () => {
    // After a Stripe account cutover ensureStripeCustomer replaces the
    // settings id; the historical subscription row still names the previous
    // account's customer (Codex P1 on #3392).
    const state = makeState();
    state.settingsCustomerId = "cus_live_new";
    state.subRow = { stripeCustomerId: "cus_stale_old" };
    dbHolder.instance = makeDb(state);
    getOrgBillingSettingsMock.mockResolvedValue(
      makeSettings({ autoReloadThresholdCents: 500n }),
    );
    effectiveBalanceMock.mockResolvedValue(100n);

    const result = await maybeAutoReload("org-abc");

    expect(result.reloaded).toBe(true);
    expect(getDefaultPaymentMethodIdMock).toHaveBeenCalledWith("cus_live_new");
    expect(chargeOffSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: "cus_live_new" }),
    );
    expect(chargeOffSessionMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ customerId: "cus_stale_old" }),
    );
  });

  it("uses customer default payment method when no saved PM in settings", async () => {
    const state = makeState();
    state.subRow = { stripeCustomerId: "cus_test_001" };
    dbHolder.instance = makeDb(state);
    getOrgBillingSettingsMock.mockResolvedValue(
      makeSettings({
        autoReloadPaymentMethodId: null,
      }),
    );
    effectiveBalanceMock.mockResolvedValue(100n);
    getDefaultPaymentMethodIdMock.mockResolvedValue("pm_customer_default");

    await maybeAutoReload("org-abc");

    expect(chargeOffSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentMethodId: "pm_customer_default",
      }),
    );
  });

  it("returns reloaded=false with reason on charge failure", async () => {
    const state = makeState();
    state.subRow = { stripeCustomerId: "cus_test_001" };
    dbHolder.instance = makeDb(state);
    getOrgBillingSettingsMock.mockResolvedValue(makeSettings());
    effectiveBalanceMock.mockResolvedValue(100n);
    chargeOffSessionMock.mockRejectedValue(new Error("card_declined"));

    const result = await maybeAutoReload("org-abc");
    expect(result.reloaded).toBe(false);
    expect(result.reason).toBe("card_declined");
    expect(createCreditLotMock).not.toHaveBeenCalled();
    expect(state.lastAutoReloadAt).toBeNull();
  });

  it("does not throw and does not stamp lastAutoReloadAt when the grant fails after a successful charge", async () => {
    // C-2: the card was charged but the credit-lot write fails. We must NOT
    // throw (would crash the caller's admission gate) and must NOT set
    // lastAutoReloadAt — so the next turn retries the grant against the same
    // (idempotency-deduped) charge instead of leaving the customer uncredited.
    const state = makeState();
    state.subRow = { stripeCustomerId: "cus_test_001" };
    dbHolder.instance = makeDb(state);
    getOrgBillingSettingsMock.mockResolvedValue(makeSettings());
    effectiveBalanceMock.mockResolvedValue(100n);
    chargeOffSessionMock.mockResolvedValue({
      paymentIntentId: "pi_test_001",
      status: "succeeded",
      succeeded: true,
    });
    createCreditLotMock.mockRejectedValueOnce(new Error("db connection lost"));

    const result = await maybeAutoReload("org-abc");
    expect(result.reloaded).toBe(false);
    expect(result.reason).toBe("grant_failed_after_charge");
    // The reload window must NOT be marked consumed, so a retry can self-heal —
    // and the episode key must stay claimed, since that is what the retry
    // charges under.
    expect(state.lastAutoReloadAt).toBeNull();
    expect(state.episodeKey).not.toBeNull();
  });

  it("returns reloaded=false when charge did not succeed", async () => {
    const state = makeState();
    state.subRow = { stripeCustomerId: "cus_test_001" };
    dbHolder.instance = makeDb(state);
    getOrgBillingSettingsMock.mockResolvedValue(makeSettings());
    effectiveBalanceMock.mockResolvedValue(100n);
    chargeOffSessionMock.mockResolvedValue({
      paymentIntentId: "pi_test_001",
      status: "requires_payment_method",
      succeeded: false,
    });

    const result = await maybeAutoReload("org-abc");
    expect(result.reloaded).toBe(false);
    expect(result.reason).toBe("charge_status:requires_payment_method");
    expect(createCreditLotMock).not.toHaveBeenCalled();
  });
});

describe("maybeAutoReload — one charge per low-balance episode (#1420)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDefaultPaymentMethodIdMock.mockResolvedValue("pm_default");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not clear a replacement episode when an older reload finishes", async () => {
    const state = makeState();
    state.subRow = { stripeCustomerId: "cus_test_001" };
    dbHolder.instance = makeDb(state);
    getOrgBillingSettingsMock.mockResolvedValue(makeSettings());
    effectiveBalanceMock.mockResolvedValue(100n);
    chargeOffSessionMock.mockResolvedValue({
      paymentIntentId: "pi_test_001",
      status: "succeeded",
      succeeded: true,
    });
    const replacementStarted = new Date(Date.now() + 61 * 60 * 1000);
    createCreditLotMock.mockImplementationOnce(async () => {
      state.episodeKey = "replacement-episode";
      state.episodeStartedAt = replacementStarted;
      return { lotId: "lot-1", effectiveBalanceCents: 1000n };
    });

    await maybeAutoReload("org-abc");
    expect(state.episodeKey).toBe("replacement-episode");
    expect(state.episodeStartedAt).toEqual(replacementStarted);
    expect(state.lastAutoReloadAt).toBeNull();
    const predicate = state.closePredicates[0];
    expect(predicate).toBeDefined();
    if (!predicate) throw new Error("Expected an episode close");
    const query = new PgDialect().sqlToQuery(predicate);
    expect(query.sql).toContain('"org_id" =');
    expect(query.sql).toContain('"auto_reload_episode_key" =');
    expect(query.params).toEqual(["org-abc", "episode-1"]);
  });

  it("refuses a stale settings read after another reload completed", async () => {
    const state = makeState();
    state.subRow = { stripeCustomerId: "cus_test_001" };
    state.lastAutoReloadAt = new Date();
    dbHolder.instance = makeDb(state);
    getOrgBillingSettingsMock.mockResolvedValue(
      makeSettings({ lastAutoReloadAt: null }),
    );
    effectiveBalanceMock.mockResolvedValue(100n);

    const result = await maybeAutoReload("org-abc");
    expect(result.reloaded).toBe(false);
    expect(chargeOffSessionMock).not.toHaveBeenCalled();
    expect(createCreditLotMock).not.toHaveBeenCalled();
    const predicate = state.claimPredicates[0];
    expect(predicate).toBeDefined();
    if (!predicate) throw new Error("Expected an atomic reload claim");
    const query = new PgDialect().sqlToQuery(predicate);
    expect(query.sql).toContain('"last_auto_reload_at" is null');
    expect(query.sql).toContain('"last_auto_reload_at" <');
    expect(query.sql).toContain('"auto_reload_enabled" =');
    expect(query.params).toContain("org-abc");
    expect(query.params).toContain(true);
  });

  it("retries under the ORIGINAL idempotency key across an hour boundary", async () => {
    // The witness for #1420. The key used to be bucketed by calendar hour while
    // the retry it protects is bounded by elapsed time, so a retry forty
    // seconds after a 10:59:30 charge computed a different key, Stripe did not
    // de-duplicate it, and the card was charged twice for one top-up — on the
    // error path that exists to protect the customer.
    const state = makeState();
    state.subRow = { stripeCustomerId: "cus_test_001" };
    dbHolder.instance = makeDb(state);
    getOrgBillingSettingsMock.mockResolvedValue(makeSettings());
    effectiveBalanceMock.mockResolvedValue(100n);
    chargeOffSessionMock.mockResolvedValue({
      paymentIntentId: "pi_test_001",
      status: "succeeded",
      succeeded: true,
    });

    vi.useFakeTimers();

    // 10:59:30 — the card is charged and the credit grant then fails.
    const chargedAt = new Date(Date.UTC(2026, 8, 6, 10, 59, 30));
    vi.setSystemTime(chargedAt);
    state.now = chargedAt;
    createCreditLotMock.mockRejectedValueOnce(new Error("db connection lost"));
    const first = await maybeAutoReload("org-abc");
    expect(first.reason).toBe("grant_failed_after_charge");

    // 11:00:10 — forty seconds later, on the other side of the hour.
    const retriedAt = new Date(Date.UTC(2026, 8, 6, 11, 0, 10));
    vi.setSystemTime(retriedAt);
    state.now = retriedAt;
    createCreditLotMock.mockResolvedValue({
      lotId: "lot-1",
      effectiveBalanceCents: 3000n,
    });
    const second = await maybeAutoReload("org-abc");
    expect(second.reloaded).toBe(true);

    const keys = chargeOffSessionMock.mock.calls.map(
      (call) => (call[0] as { idempotencyKey: string }).idempotencyKey,
    );
    expect(keys).toHaveLength(2);
    // One key, so Stripe sees one charge.
    expect(keys[1]).toBe(keys[0]);

    // The episode ends when the credits exist, not when the clock rolls over.
    expect(state.lastAutoReloadAt).toEqual(retriedAt);
    expect(state.episodeKey).toBeNull();
  });

  it("refuses to charge again once the episode outlives Stripe's idempotency window", async () => {
    // Past 24 hours Stripe has forgotten the key, so re-sending it would charge
    // the card rather than de-duplicate. Stop and alert instead.
    const state = makeState();
    state.subRow = { stripeCustomerId: "cus_test_001" };
    dbHolder.instance = makeDb(state);
    getOrgBillingSettingsMock.mockResolvedValue(makeSettings());
    effectiveBalanceMock.mockResolvedValue(100n);

    state.episodeKey = "auto_reload:org-abc:stale";
    state.episodeStartedAt = new Date(Date.now() - 25 * 60 * 60 * 1000);

    const result = await maybeAutoReload("org-abc");
    expect(result.reloaded).toBe(false);
    expect(result.reason).toBe("episode_stale");
    expect(chargeOffSessionMock).not.toHaveBeenCalled();
  });

  it("gives a fresh episode a new key once the previous one is closed", async () => {
    const state = makeState();
    state.subRow = { stripeCustomerId: "cus_test_001" };
    dbHolder.instance = makeDb(state);
    getOrgBillingSettingsMock.mockResolvedValue(makeSettings());
    effectiveBalanceMock.mockResolvedValue(100n);
    chargeOffSessionMock.mockResolvedValue({
      paymentIntentId: "pi_test_001",
      status: "succeeded",
      succeeded: true,
    });
    createCreditLotMock.mockResolvedValue({
      lotId: "lot-1",
      effectiveBalanceCents: 3000n,
    });

    await maybeAutoReload("org-abc");
    vi.useFakeTimers();
    const nextHour = new Date(Date.now() + 61 * 60 * 1000);
    vi.setSystemTime(nextHour);
    state.now = nextHour;
    await maybeAutoReload("org-abc");

    const keys = chargeOffSessionMock.mock.calls.map(
      (call) => (call[0] as { idempotencyKey: string }).idempotencyKey,
    );
    expect(keys).toHaveLength(2);
    // A finished reload releases its key, so the next top-up is its own charge.
    expect(keys[1]).not.toBe(keys[0]);
  });
});

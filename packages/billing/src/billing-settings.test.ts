/**
 * Unit tests for packages/billing/src/billing-settings.ts
 *
 * Mocks:
 *  - @oxagen/database → db() factory
 *
 * Covers:
 *  1. getOrgBillingSettings — creates a default row on first call (insert + read)
 *  2. getOrgBillingSettings — returns existing row without re-inserting
 *  3. updateAutoReloadSettings — updates enabled flag
 *  4. updateAutoReloadSettings — updates thresholdCents + amountCents
 *  5. updateAutoReloadSettings — rejects thresholdCents < 0
 *  6. updateAutoReloadSettings — rejects amountCents < 100
 *  7. updateAutoReloadSettings — accepts amountCents exactly 100
 *  8. updateAutoReloadSettings — accepts thresholdCents = 0
 *  9. getOrgBillingSettings — throws when DB returns no row after insert
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// DB mock
// ---------------------------------------------------------------------------

const insertOnConflictDoNothingMock = vi.fn().mockResolvedValue(undefined);
const insertValuesMock = vi.fn().mockReturnValue({
  onConflictDoNothing: insertOnConflictDoNothingMock,
});
const insertMock = vi.fn().mockReturnValue({ values: insertValuesMock });

const updateSetMock = vi.fn();
const updateWhereMock = vi.fn().mockResolvedValue(undefined);
updateSetMock.mockReturnValue({ where: updateWhereMock });
const updateMock = vi.fn().mockReturnValue({ set: updateSetMock });

const findFirstMock = vi.fn();

const dbMocks = {
  insert: insertMock,
  update: updateMock,
  query: {
    orgBillingSettings: { findFirst: findFirstMock },
  },
};

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    db: () => dbMocks,
    // Spies (not bare passthroughs) so tests can assert WHICH runner a call routed
    // through — the dunning-sweep fix depends on getOrgBillingSettings using
    // withSystemDb (no tenant scope) when { system: true } is passed.
    withTenantDb: vi.fn(async (fn: (tx: typeof dbMocks) => unknown) =>
      fn(dbMocks),
    ),
    withSystemDb: vi.fn(async (fn: (tx: typeof dbMocks) => unknown) =>
      fn(dbMocks),
    ),
  };
});

// Import after mocks.
const { getOrgBillingSettings, updateAutoReloadSettings } = await import(
  "./billing-settings"
);
const { withTenantDb, withSystemDb } = await import("@oxagen/database");

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeSettingsRow(overrides: Record<string, unknown> = {}) {
  return {
    orgId: "org-001",
    autoReloadEnabled: false,
    autoReloadThresholdCents: BigInt(500),
    autoReloadAmountCents: BigInt(2000),
    autoReloadPaymentMethodId: null,
    lowBalanceThresholdCents: BigInt(500),
    dunningState: "active",
    delinquentSince: null,
    graceEndsAt: null,
    suspendedAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getOrgBillingSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertOnConflictDoNothingMock.mockResolvedValue(undefined);
  });

  it("routes through withTenantDb by default (request path → RLS enforced)", async () => {
    findFirstMock.mockResolvedValue(makeSettingsRow());
    await getOrgBillingSettings("org-001");
    expect(withTenantDb).toHaveBeenCalledOnce();
    expect(withSystemDb).not.toHaveBeenCalled();
  });

  it("routes through withSystemDb when { system: true } (trusted cron, no tenant scope)", async () => {
    // Regression: billing.dunning-sweep calls this with no active tenant scope.
    // withTenantDb would throw TenantScopeError; the system flag must select
    // withSystemDb instead so the low-balance sweep works for every org.
    findFirstMock.mockResolvedValue(makeSettingsRow());
    await getOrgBillingSettings("org-001", { system: true });
    expect(withSystemDb).toHaveBeenCalledOnce();
    expect(withTenantDb).not.toHaveBeenCalled();
  });

  it("creates default row on first call and returns it", async () => {
    findFirstMock.mockResolvedValue(makeSettingsRow());

    const result = await getOrgBillingSettings("org-001");

    // Should have attempted an insert (default row creation).
    expect(insertMock).toHaveBeenCalledOnce();
    expect(insertOnConflictDoNothingMock).toHaveBeenCalledOnce();

    // Should read back the row.
    expect(findFirstMock).toHaveBeenCalledOnce();

    // Numeric conversion from bigint.
    expect(result.orgId).toBe("org-001");
    expect(result.autoReloadEnabled).toBe(false);
    expect(result.autoReloadThresholdCents).toBe(500);
    expect(result.autoReloadAmountCents).toBe(2000);
    expect(result.lowBalanceThresholdCents).toBe(500);
    expect(result.dunningState).toBe("active");
    expect(result.delinquentSince).toBeNull();
  });

  it("returns mapped OrgBillingSettings with non-default values", async () => {
    findFirstMock.mockResolvedValue(
      makeSettingsRow({
        autoReloadEnabled: true,
        autoReloadThresholdCents: BigInt(1000),
        autoReloadAmountCents: BigInt(5000),
        autoReloadPaymentMethodId: "pm_abc123",
        lowBalanceThresholdCents: BigInt(300),
        dunningState: "grace",
        delinquentSince: new Date("2026-01-01"),
        graceEndsAt: new Date("2026-01-08"),
      }),
    );

    const result = await getOrgBillingSettings("org-001");

    expect(result.autoReloadEnabled).toBe(true);
    expect(result.autoReloadThresholdCents).toBe(1000);
    expect(result.autoReloadAmountCents).toBe(5000);
    expect(result.autoReloadPaymentMethodId).toBe("pm_abc123");
    expect(result.lowBalanceThresholdCents).toBe(300);
    expect(result.dunningState).toBe("grace");
    expect(result.delinquentSince).toEqual(new Date("2026-01-01"));
    expect(result.graceEndsAt).toEqual(new Date("2026-01-08"));
  });

  it("throws when DB returns no row after insert", async () => {
    findFirstMock.mockResolvedValue(undefined);

    await expect(getOrgBillingSettings("org-ghost")).rejects.toThrow(
      "org-ghost",
    );
  });
});

describe("updateAutoReloadSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertOnConflictDoNothingMock.mockResolvedValue(undefined);
    // getOrgBillingSettings is called twice: once to ensure row, once after update.
    findFirstMock.mockResolvedValue(makeSettingsRow());
  });

  it("updates autoReloadEnabled to true", async () => {
    findFirstMock.mockResolvedValue(
      makeSettingsRow({
        autoReloadEnabled: true,
        autoReloadPaymentMethodId: "pm-valid-123",
      }),
    );

    const result = await updateAutoReloadSettings("org-001", { enabled: true });

    expect(updateMock).toHaveBeenCalledOnce();
    const setArg = updateSetMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(setArg.autoReloadEnabled).toBe(true);

    expect(result.autoReloadEnabled).toBe(true);
  });

  it("updates thresholdCents and amountCents (as BigInt)", async () => {
    findFirstMock.mockResolvedValue(
      makeSettingsRow({
        autoReloadThresholdCents: BigInt(250),
        autoReloadAmountCents: BigInt(500),
      }),
    );

    await updateAutoReloadSettings("org-001", {
      thresholdCents: 250,
      amountCents: 500,
    });

    const setArg = updateSetMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(setArg.autoReloadThresholdCents).toBe(BigInt(250));
    expect(setArg.autoReloadAmountCents).toBe(BigInt(500));
  });

  it("updates paymentMethodId to a string value", async () => {
    findFirstMock.mockResolvedValue(
      makeSettingsRow({ autoReloadPaymentMethodId: "pm_xyz" }),
    );

    await updateAutoReloadSettings("org-001", { paymentMethodId: "pm_xyz" });

    const setArg = updateSetMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(setArg.autoReloadPaymentMethodId).toBe("pm_xyz");
  });

  it("updates paymentMethodId to null when explicitly passed null", async () => {
    findFirstMock.mockResolvedValue(makeSettingsRow());

    await updateAutoReloadSettings("org-001", { paymentMethodId: null });

    const setArg = updateSetMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(setArg.autoReloadPaymentMethodId).toBeNull();
  });

  it("rejects thresholdCents < 0 before any DB write", async () => {
    await expect(
      updateAutoReloadSettings("org-001", { thresholdCents: -1 }),
    ).rejects.toThrow("thresholdCents must be >= 0");

    // No DB writes should have happened.
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("accepts thresholdCents = 0", async () => {
    findFirstMock.mockResolvedValue(makeSettingsRow());

    await expect(
      updateAutoReloadSettings("org-001", { thresholdCents: 0 }),
    ).resolves.toBeDefined();
  });

  it("rejects amountCents < 100 (below $1 minimum)", async () => {
    await expect(
      updateAutoReloadSettings("org-001", { amountCents: 99 }),
    ).rejects.toThrow("amountCents must be >= 100");

    expect(updateMock).not.toHaveBeenCalled();
  });

  it("accepts amountCents exactly 100 ($1.00 minimum)", async () => {
    findFirstMock.mockResolvedValue(
      makeSettingsRow({ autoReloadAmountCents: BigInt(100) }),
    );

    await expect(
      updateAutoReloadSettings("org-001", { amountCents: 100 }),
    ).resolves.toBeDefined();
  });

  it("only includes supplied keys in the update patch", async () => {
    findFirstMock.mockResolvedValue(makeSettingsRow());

    await updateAutoReloadSettings("org-001", { enabled: false });

    const setArg = updateSetMock.mock.calls[0]![0] as Record<string, unknown>;

    // Only autoReloadEnabled and updatedAt should appear in the patch.
    expect(setArg.autoReloadEnabled).toBe(false);
    expect(setArg.autoReloadThresholdCents).toBeUndefined();
    expect(setArg.autoReloadAmountCents).toBeUndefined();
    expect(setArg.autoReloadPaymentMethodId).toBeUndefined();
  });
});

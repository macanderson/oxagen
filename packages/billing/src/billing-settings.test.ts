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
 * 10. readOrgBillingSettings — the GAU-path read: column defaults for an org
 *     with no row, never an insert (asserted on the query log)
 * 11. setAutoTopup — the customer's upsert: tenant-scoped, ON CONFLICT
 *     (org_id) with a SET naming only its two columns, returns the row as
 *     stored, refuses a non-positive block count
 * 12. setOrgBillingTerms — the platform operator's upsert: system-scoped,
 *     ON CONFLICT (org_id) with a SET naming only its two columns, returns
 *     the stored row
 */

import { afterAll, describe, it, expect, vi, beforeEach } from "vitest";

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
// `.where().returning()` — used by updateAssistantSpendCap, which reads the
// updated row back from the same statement rather than re-selecting it.
const updateReturningMock = vi.fn();
updateSetMock.mockReturnValue({ where: updateWhereMock });
const updateMock = vi.fn().mockReturnValue({ set: updateSetMock });

// `.insert().values().onConflictDoUpdate().returning()` — the upsert shape the
// two GAU billing-terms writers use (setAutoTopup, setOrgBillingTerms). Kept
// separate from insertValuesMock's onConflictDoNothing chain above so a test
// can assert WHICH upsert a call made.
const upsertReturningMock = vi.fn();
const onConflictDoUpdateMock = vi
  .fn()
  .mockReturnValue({ returning: upsertReturningMock });
insertValuesMock.mockReturnValue({
  onConflictDoNothing: insertOnConflictDoNothingMock,
  onConflictDoUpdate: onConflictDoUpdateMock,
});

const findFirstMock = vi.fn();

// `.select().from().where().limit()`: the assistant-cap read.
const selectLimitMock = vi.fn();
const selectWhereMock = vi.fn().mockReturnValue({ limit: selectLimitMock });
const selectFromMock = vi.fn().mockReturnValue({ where: selectWhereMock });
const selectMock = vi.fn().mockReturnValue({ from: selectFromMock });

const dbMocks = {
  insert: insertMock,
  update: updateMock,
  select: selectMock,
  query: {
    orgBillingSettings: { findFirst: findFirstMock },
  },
};

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
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
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

// Import after mocks.
const {
  DEFAULT_ASSISTANT_SPEND_CAP_CENTS,
  getOrgBillingSettings,
  readAssistantSpendCap,
  readOrgBillingSettings,
  setAssistantSpendCap,
  setAutoTopup,
  setOrgBillingTerms,
  updateAssistantSpendCap,
  updateAutoReloadSettings,
} = await import("./billing-settings");
const { schema, withTenantDb, withSystemDb } = await import("@oxagen/database");

/** The column names an upsert's ON CONFLICT … DO UPDATE SET clause names. */
function upsertSetColumns(): string[] {
  const call = onConflictDoUpdateMock.mock.calls[0];
  if (!call) throw new Error("expected one onConflictDoUpdate call");
  return Object.keys((call[0] as { set: Record<string, unknown> }).set).sort();
}

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
    assistantSpendCapCents: BigInt(2000),
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

  // ── ADR-053 §3: the assistant spend cap ────────────────────────────────────

  it("seeds a new row with the default assistant spend cap", async () => {
    findFirstMock.mockResolvedValue(makeSettingsRow());
    await getOrgBillingSettings("org-001");
    const values = insertValuesMock.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(values.assistantSpendCapCents).toBe(
      BigInt(DEFAULT_ASSISTANT_SPEND_CAP_CENTS),
    );
    expect(DEFAULT_ASSISTANT_SPEND_CAP_CENTS).toBe(2_000);
  });

  it("maps a numeric assistantSpendCapCents from bigint", async () => {
    findFirstMock.mockResolvedValue(
      makeSettingsRow({ assistantSpendCapCents: BigInt(7500) }),
    );
    const result = await getOrgBillingSettings("org-001");
    expect(result.assistantSpendCapCents).toBe(7500);
  });

  it("maps a NULL assistantSpendCapCents to null (no cap), never to 0 or NaN", async () => {
    findFirstMock.mockResolvedValue(
      makeSettingsRow({ assistantSpendCapCents: null }),
    );
    const result = await getOrgBillingSettings("org-001");
    expect(result.assistantSpendCapCents).toBeNull();
  });
});

describe("updateAssistantSpendCap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertOnConflictDoNothingMock.mockResolvedValue(undefined);
    findFirstMock.mockResolvedValue(makeSettingsRow());
    updateWhereMock.mockReturnValue({ returning: updateReturningMock });
    updateReturningMock.mockResolvedValue([makeSettingsRow()]);
  });

  afterAll(() => {
    updateWhereMock.mockResolvedValue(undefined);
  });

  it("rejects a negative cap before any DB write", async () => {
    await expect(updateAssistantSpendCap("org-001", -1)).rejects.toThrow(
      "assistantSpendCapCents must be a non-negative integer or null",
    );
    expect(updateMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("rejects a non-integer cap before any DB write", async () => {
    await expect(updateAssistantSpendCap("org-001", 12.5)).rejects.toThrow(
      "non-negative integer",
    );
    await expect(
      updateAssistantSpendCap("org-001", Number.NaN),
    ).rejects.toThrow("non-negative integer");
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("writes a numeric cap as BigInt and returns the mapped row", async () => {
    updateReturningMock.mockResolvedValue([
      makeSettingsRow({ assistantSpendCapCents: BigInt(5000) }),
    ]);
    const result = await updateAssistantSpendCap("org-001", 5000);
    expect(updateMock).toHaveBeenCalledOnce();
    const setArg = updateSetMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(setArg.assistantSpendCapCents).toBe(BigInt(5000));
    expect(setArg.updatedAt).toBeInstanceOf(Date);
    expect(result.assistantSpendCapCents).toBe(5000);
  });

  it("accepts zero — the opt-out for an organisation with no key of its own", async () => {
    updateReturningMock.mockResolvedValue([
      makeSettingsRow({ assistantSpendCapCents: BigInt(0) }),
    ]);
    const result = await updateAssistantSpendCap("org-001", 0);
    const setArg = updateSetMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(setArg.assistantSpendCapCents).toBe(BigInt(0));
    expect(result.assistantSpendCapCents).toBe(0);
  });

  it("accepts null and writes NULL (no cap)", async () => {
    updateReturningMock.mockResolvedValue([
      makeSettingsRow({ assistantSpendCapCents: null }),
    ]);
    const result = await updateAssistantSpendCap("org-001", null);
    const setArg = updateSetMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(setArg.assistantSpendCapCents).toBeNull();
    expect(result.assistantSpendCapCents).toBeNull();
  });

  it("ensures the settings row exists before updating it", async () => {
    await updateAssistantSpendCap("org-001", 100);
    // getOrgBillingSettings ran first: its insert-on-conflict is the guarantee.
    expect(insertMock).toHaveBeenCalledOnce();
    expect(withTenantDb).toHaveBeenCalledTimes(2);
    expect(withSystemDb).not.toHaveBeenCalled();
  });

  it("throws when the update returns no row", async () => {
    updateReturningMock.mockResolvedValue([]);
    await expect(updateAssistantSpendCap("org-ghost", 100)).rejects.toThrow(
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

// ---------------------------------------------------------------------------
// readOrgBillingSettings — ADR-055 §5: a read never writes
// ---------------------------------------------------------------------------

describe("readOrgBillingSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads inside the caller's tenant scope by default", async () => {
    findFirstMock.mockResolvedValue(undefined);
    await readOrgBillingSettings("org-001");
    expect(withTenantDb).toHaveBeenCalledOnce();
    expect(withSystemDb).not.toHaveBeenCalled();
  });

  it("reads through withSystemDb with { system: true }, for the close job and the operator handler", async () => {
    findFirstMock.mockResolvedValue(undefined);
    const result = await readOrgBillingSettings("org-001", { system: true });
    expect(withSystemDb).toHaveBeenCalledOnce();
    expect(withTenantDb).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
    expect(result.approvedForInvoiceBilling).toBe(false);
  });

  it("returns the column defaults for an org with no row and issues NO insert", async () => {
    findFirstMock.mockResolvedValue(undefined);

    const result = await readOrgBillingSettings("org-new");

    expect(result).toEqual({
      orgId: "org-new",
      stripeCustomerId: null,
      approvedForInvoiceBilling: false,
      invoiceGauMax: 100_000,
      autoTopupEnabled: true,
      autoTopupBlocks: 1,
      dunningState: "active",
    });
    // The query log: one SELECT, no INSERT, no UPDATE.
    expect(findFirstMock).toHaveBeenCalledOnce();
    expect(insertMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("returns the stored row and still never inserts", async () => {
    findFirstMock.mockResolvedValue({
      stripeCustomerId: "cus_123",
      approvedForInvoiceBilling: true,
      invoiceGauMax: 250_000,
      autoTopupEnabled: false,
      autoTopupBlocks: 4,
      dunningState: "suspended",
    });

    const result = await readOrgBillingSettings("org-001");

    expect(result).toEqual({
      orgId: "org-001",
      stripeCustomerId: "cus_123",
      approvedForInvoiceBilling: true,
      invoiceGauMax: 250_000,
      autoTopupEnabled: false,
      autoTopupBlocks: 4,
      dunningState: "suspended",
    });
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("reads through withTenantDb (the callers run inside a tenant scope)", async () => {
    findFirstMock.mockResolvedValue(undefined);
    await readOrgBillingSettings("org-001");
    expect(withTenantDb).toHaveBeenCalledOnce();
    expect(withSystemDb).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// setAutoTopup — the customer's write (ADR-055 §5, set_auto_topup)
// ---------------------------------------------------------------------------

describe("setAutoTopup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertValuesMock.mockReturnValue({
      onConflictDoNothing: insertOnConflictDoNothingMock,
      onConflictDoUpdate: onConflictDoUpdateMock,
    });
    onConflictDoUpdateMock.mockReturnValue({ returning: upsertReturningMock });
  });

  it("upserts the two columns and returns them as stored", async () => {
    upsertReturningMock.mockResolvedValue([
      { autoTopupEnabled: true, autoTopupBlocks: 3 },
    ]);

    const result = await setAutoTopup("org-001", { enabled: true, blocks: 3 });

    expect(result).toEqual({ enabled: true, blocks: 3 });
    expect(insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-001",
        autoTopupEnabled: true,
        autoTopupBlocks: 3,
      }),
    );
  });

  it("is keyed on org_id and updates only its own two columns on conflict", async () => {
    upsertReturningMock.mockResolvedValue([
      { autoTopupEnabled: true, autoTopupBlocks: 3 },
    ]);

    await setAutoTopup("org-001", { enabled: true, blocks: 3 });

    expect(onConflictDoUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ target: schema.orgBillingSettings.orgId }),
    );
    expect(upsertSetColumns()).toEqual([
      "autoTopupBlocks",
      "autoTopupEnabled",
      "updatedAt",
    ]);
  });

  it("answers with the stored row rather than the requested values", async () => {
    upsertReturningMock.mockResolvedValue([
      { autoTopupEnabled: false, autoTopupBlocks: 1 },
    ]);

    await expect(
      setAutoTopup("org-001", { enabled: true, blocks: 9 }),
    ).resolves.toEqual({ enabled: false, blocks: 1 });
  });

  it("writes through withTenantDb — the capability is scoped and RLS is the fence", async () => {
    upsertReturningMock.mockResolvedValue([
      { autoTopupEnabled: true, autoTopupBlocks: 1 },
    ]);

    await setAutoTopup("org-001", { enabled: true, blocks: 1 });

    expect(withTenantDb).toHaveBeenCalledOnce();
    expect(withSystemDb).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5])(
    "refuses %s blocks before any write",
    async (blocks) => {
      await expect(
        setAutoTopup("org-001", { enabled: true, blocks }),
      ).rejects.toThrow(/blocks must be >= 1/);
      expect(insertMock).not.toHaveBeenCalled();
    },
  );

  it("throws when the upsert returns no row", async () => {
    upsertReturningMock.mockResolvedValue([]);

    await expect(
      setAutoTopup("org-001", { enabled: true, blocks: 1 }),
    ).rejects.toThrow(/failed to save auto top-up/);
  });
});

// ---------------------------------------------------------------------------
// setOrgBillingTerms — the platform operator's write (set_org_billing_terms)
// ---------------------------------------------------------------------------

describe("setOrgBillingTerms", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertValuesMock.mockReturnValue({
      onConflictDoNothing: insertOnConflictDoNothingMock,
      onConflictDoUpdate: onConflictDoUpdateMock,
    });
    onConflictDoUpdateMock.mockReturnValue({ returning: upsertReturningMock });
  });

  it("upserts the terms and returns the stored row", async () => {
    upsertReturningMock.mockResolvedValue([
      {
        orgId: "org-001",
        approvedForInvoiceBilling: true,
        invoiceGauMax: 250_000,
      },
    ]);

    const result = await setOrgBillingTerms({
      orgId: "org-001",
      approvedForInvoiceBilling: true,
      invoiceGauMax: 250_000,
    });

    expect(result).toEqual({
      orgId: "org-001",
      approvedForInvoiceBilling: true,
      invoiceGauMax: 250_000,
    });
    expect(insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-001",
        approvedForInvoiceBilling: true,
        invoiceGauMax: 250_000,
      }),
    );
  });

  it("is keyed on org_id and updates only its own two columns on conflict", async () => {
    upsertReturningMock.mockResolvedValue([
      {
        orgId: "org-001",
        approvedForInvoiceBilling: true,
        invoiceGauMax: 250_000,
      },
    ]);

    await setOrgBillingTerms({
      orgId: "org-001",
      approvedForInvoiceBilling: true,
      invoiceGauMax: 250_000,
    });

    expect(onConflictDoUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ target: schema.orgBillingSettings.orgId }),
    );
    expect(upsertSetColumns()).toEqual([
      "approvedForInvoiceBilling",
      "invoiceGauMax",
      "updatedAt",
    ]);
  });

  it("writes through withSystemDb — the call carries no tenant to scope to", async () => {
    upsertReturningMock.mockResolvedValue([
      {
        orgId: "org-001",
        approvedForInvoiceBilling: false,
        invoiceGauMax: 100_000,
      },
    ]);

    await setOrgBillingTerms({
      orgId: "org-001",
      approvedForInvoiceBilling: false,
      invoiceGauMax: 100_000,
    });

    expect(withSystemDb).toHaveBeenCalledOnce();
    expect(withTenantDb).not.toHaveBeenCalled();
  });

  it.each([0, -1, 2.5])(
    "refuses an invoiceGauMax of %s before any write",
    async (invoiceGauMax) => {
      await expect(
        setOrgBillingTerms({
          orgId: "org-001",
          approvedForInvoiceBilling: true,
          invoiceGauMax,
        }),
      ).rejects.toThrow(/invoiceGauMax must be >= 1/);
      expect(insertMock).not.toHaveBeenCalled();
    },
  );

  it("throws when the upsert returns no row", async () => {
    upsertReturningMock.mockResolvedValue([]);

    await expect(
      setOrgBillingTerms({
        orgId: "org-001",
        approvedForInvoiceBilling: true,
        invoiceGauMax: 1,
      }),
    ).rejects.toThrow(/failed to save billing terms/);
  });
});

// ---------------------------------------------------------------------------
// The Free-tier default (maintainer, 2026-09-14; ADR-055 §6)
// ---------------------------------------------------------------------------

describe("the Free-tier auto top-up default", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is on, at one block, for a Free org that has never touched its settings", async () => {
    // A Free org has no org_billing_settings row until it buys something or
    // saves a card, so this is the state every Free org is in. Auto top-up is
    // already on: once a card exists the recorder charges it for one
    // 5,000-GAU block at the list rate, with no setting change (the rule the
    // 2026-09-14 direction states).
    findFirstMock.mockResolvedValue(undefined);

    const settings = await readOrgBillingSettings("org-free");

    expect(settings.autoTopupEnabled).toBe(true);
    expect(settings.autoTopupBlocks).toBe(1);
    expect(settings.approvedForInvoiceBilling).toBe(false);
    expect(insertMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The assistant spend cap on a system transaction (the platform operator's
// two paths: set_org_billing_terms and a prepaid order's credits grant)
// ---------------------------------------------------------------------------

describe("readAssistantSpendCap / setAssistantSpendCap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertValuesMock.mockReturnValue({
      onConflictDoNothing: insertOnConflictDoNothingMock,
      onConflictDoUpdate: onConflictDoUpdateMock,
    });
    onConflictDoUpdateMock.mockReturnValue({ returning: upsertReturningMock });
    selectWhereMock.mockReturnValue({ limit: selectLimitMock });
    selectFromMock.mockReturnValue({ where: selectWhereMock });
    selectMock.mockReturnValue({ from: selectFromMock });
  });

  it("reads the stored cap on withSystemDb, and the column default for an org with no row", async () => {
    selectLimitMock.mockResolvedValueOnce([{ capCents: 600_000n }]);
    expect(await readAssistantSpendCap("org-001")).toBe(600_000);

    selectLimitMock.mockResolvedValueOnce([{ capCents: null }]);
    expect(await readAssistantSpendCap("org-001")).toBeNull();

    selectLimitMock.mockResolvedValueOnce([]);
    expect(await readAssistantSpendCap("org-001")).toBe(
      DEFAULT_ASSISTANT_SPEND_CAP_CENTS,
    );
    expect(withSystemDb).toHaveBeenCalledTimes(3);
    expect(withTenantDb).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("upserts the cap keyed on org_id, setting only the cap, and returns what was stored", async () => {
    upsertReturningMock.mockResolvedValue([{ capCents: 600_000n }]);

    expect(await setAssistantSpendCap("org-001", 600_000)).toBe(600_000);

    expect(insertValuesMock).toHaveBeenCalledWith({
      orgId: "org-001",
      assistantSpendCapCents: 600_000n,
    });
    expect(onConflictDoUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ target: schema.orgBillingSettings.orgId }),
    );
    expect(upsertSetColumns()).toEqual(["assistantSpendCapCents", "updatedAt"]);
    expect(withSystemDb).toHaveBeenCalledOnce();
    expect(withTenantDb).not.toHaveBeenCalled();
  });

  it("removes the cap with null", async () => {
    upsertReturningMock.mockResolvedValue([{ capCents: null }]);

    expect(await setAssistantSpendCap("org-001", null)).toBeNull();
    expect(insertValuesMock).toHaveBeenCalledWith({
      orgId: "org-001",
      assistantSpendCapCents: null,
    });
  });

  it.each([-1, 2.5, Number.MAX_SAFE_INTEGER + 1])(
    "refuses a cap of %s before any write",
    async (cap) => {
      await expect(setAssistantSpendCap("org-001", cap)).rejects.toThrow(
        /non-negative integer or null/,
      );
      expect(insertMock).not.toHaveBeenCalled();
    },
  );
});

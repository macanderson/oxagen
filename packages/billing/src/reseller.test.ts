import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Fake tenant DB ────────────────────────────────────────────────────────────
// A stateful, chainable stand-in for the Drizzle tx handle threaded through
// withTenantDb. Keyed by the real schema table objects (we spread the real
// module so the tables are identity-stable), it supports the exact query shapes
// the reseller domain uses: select().from().where()[.orderBy()][.limit()],
// insert().values()[.returning()], update().set().where()[.returning()], delete().where().
const h = vi.hoisted(() => {
  interface FakeDb {
    rows: Map<unknown, Record<string, unknown>[]>;
    inserted: { table: unknown; values: unknown }[];
    updated: { table: unknown; values: Record<string, unknown> }[];
    deleted: unknown[];
  }
  const fakeDb: FakeDb = {
    rows: new Map(),
    inserted: [],
    updated: [],
    deleted: [],
  };
  let counter = 1;
  const now = new Date("2026-07-10T00:00:00.000Z");

  function makeTx() {
    const tx = {
      select() {
        let table: unknown;
        const chain = {
          from(t: unknown) {
            table = t;
            return chain;
          },
          where() {
            return chain;
          },
          orderBy() {
            return chain;
          },
          limit() {
            return chain;
          },
          then(res: (v: unknown[]) => unknown, rej?: (e: unknown) => unknown) {
            return Promise.resolve(fakeDb.rows.get(table) ?? []).then(res, rej);
          },
        };
        return chain;
      },
      insert(table: unknown) {
        return {
          values(values: Record<string, unknown> | Record<string, unknown>[]) {
            const arr = Array.isArray(values) ? values : [values];
            const created = arr.map((v) => {
              const row = {
                id: `id-${counter}`,
                publicId: `pub-${counter++}`,
                createdAt: now,
                updatedAt: now,
                ...v,
              };
              const list = fakeDb.rows.get(table) ?? [];
              list.push(row);
              fakeDb.rows.set(table, list);
              fakeDb.inserted.push({ table, values: v });
              return row;
            });
            return {
              returning() {
                return Promise.resolve(created);
              },
              then(
                res: (v: unknown[]) => unknown,
                rej?: (e: unknown) => unknown,
              ) {
                return Promise.resolve(created).then(res, rej);
              },
            };
          },
        };
      },
      update(table: unknown) {
        return {
          set(values: Record<string, unknown>) {
            fakeDb.updated.push({ table, values });
            const list = fakeDb.rows.get(table) ?? [];
            const base = list[0] ?? {};
            const merged = { ...base, ...values };
            if (list[0]) Object.assign(list[0], values);
            const where = {
              returning() {
                return Promise.resolve([merged]);
              },
              then(
                res: (v: unknown) => unknown,
                rej?: (e: unknown) => unknown,
              ) {
                return Promise.resolve(undefined).then(res, rej);
              },
            };
            return { where: () => where };
          },
        };
      },
      delete(table: unknown) {
        return {
          where() {
            fakeDb.deleted.push(table);
            return Promise.resolve(undefined);
          },
        };
      },
    };
    return tx;
  }

  return {
    fakeDb,
    makeTx,
    readSlicesMock: vi.fn(),
    createExternalInvoiceMock: vi.fn(),
  };
});

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    db: () => h.makeTx(),
    withTenantDb: async (fn: (tx: unknown) => unknown) => fn(h.makeTx()),
    withSystemDb: async (fn: (tx: unknown) => unknown) => fn(h.makeTx()),
  };
});

vi.mock("@oxagen/telemetry", () => ({
  readResellerUsageAttribution: h.readSlicesMock,
}));

vi.mock("./client", () => ({
  resellerBillingProvider: () => ({
    createExternalInvoice: h.createExternalInvoiceMock,
  }),
}));

vi.mock("./reseller-secret", () => ({
  encryptResellerSecret: async () => ({
    ciphertext: Buffer.from("cipher"),
    keyId: "billing:reseller:env:v1",
  }),
  decryptResellerSecret: async () => "sk_test_decrypted",
  secretLast4: (s: string) => s.slice(-4),
  RESELLER_KEY_ID: "billing:reseller:env:v1",
}));

// Imports AFTER mocks so the mocked modules are used.
import { schema } from "@oxagen/database";
import {
  createResellerCustomer,
  listResellerCustomers,
  updateResellerCustomer,
  archiveResellerCustomer,
  createResellerPricePlan,
  listResellerPricePlans,
  updateResellerPricePlan,
  saveResellerAttributionRule,
  listResellerAttributionRules,
  deleteResellerAttributionRule,
  configureResellerStripe,
  getResellerStripeStatus,
} from "./reseller";
import {
  previewResellerRebill,
  pushResellerRebill,
  listResellerRebillRuns,
} from "./reseller-rebill";

const CTX = { orgId: "org-1", userId: "user-1" };
const now = new Date("2026-07-10T00:00:00.000Z");

function planRow(over: Record<string, unknown> = {}) {
  return {
    id: "plan-int-1",
    publicId: "resplan_1",
    name: "20% markup",
    pricingMode: "markup",
    markupBps: 2000,
    unitPriceCents: null,
    currency: "usd",
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...over,
  };
}
function customerRow(over: Record<string, unknown> = {}) {
  return {
    id: "cust-int-1",
    publicId: "rescus_1",
    name: "Acme",
    externalRef: null,
    stripeCustomerId: null,
    pricePlanId: "plan-int-1",
    status: "active",
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...over,
  };
}

beforeEach(() => {
  h.fakeDb.rows = new Map();
  h.fakeDb.inserted = [];
  h.fakeDb.updated = [];
  h.fakeDb.deleted = [];
  h.readSlicesMock.mockReset();
  h.createExternalInvoiceMock.mockReset();
});

// ── Customers ────────────────────────────────────────────────────────────────

describe("reseller customers", () => {
  it("creates a customer and resolves its plan public id + name", async () => {
    h.fakeDb.rows.set(schema.resellerPricePlans, [planRow()]);
    const customer = await createResellerCustomer(CTX, {
      name: "Acme",
      pricePlanId: "resplan_1",
    });
    expect(customer.name).toBe("Acme");
    expect(customer.pricePlanId).toBe("resplan_1");
    expect(customer.pricePlanName).toBe("20% markup");
    expect(customer.status).toBe("active");
  });

  it("throws when creating with an unknown plan id", async () => {
    h.fakeDb.rows.set(schema.resellerPricePlans, []);
    await expect(
      createResellerCustomer(CTX, {
        name: "X",
        pricePlanId: "resplan_missing",
      }),
    ).rejects.toThrow(/price plan not found/);
  });

  it("lists customers (optionally filtered by status)", async () => {
    h.fakeDb.rows.set(schema.resellerPricePlans, [planRow()]);
    h.fakeDb.rows.set(schema.resellerCustomers, [
      customerRow(),
      customerRow({
        id: "c2",
        publicId: "rescus_2",
        name: "Beta",
        status: "paused",
      }),
    ]);
    const all = await listResellerCustomers(CTX, {});
    expect(all).toHaveLength(2);
    expect(all[0]!.pricePlanName).toBe("20% markup");
    const active = await listResellerCustomers(CTX, { status: "active" });
    // The fake ignores the WHERE, but the status filter branch is exercised.
    expect(active).toHaveLength(2);
  });

  it("updates a customer", async () => {
    h.fakeDb.rows.set(schema.resellerCustomers, [customerRow()]);
    h.fakeDb.rows.set(schema.resellerPricePlans, [planRow()]);
    const updated = await updateResellerCustomer(CTX, {
      id: "rescus_1",
      name: "Acme Renamed",
      status: "paused",
    });
    expect(updated.name).toBe("Acme Renamed");
    expect(updated.status).toBe("paused");
  });

  it("throws updating a missing customer", async () => {
    h.fakeDb.rows.set(schema.resellerCustomers, []);
    await expect(
      updateResellerCustomer(CTX, { id: "rescus_x", name: "N" }),
    ).rejects.toThrow(/customer not found/);
  });

  it("archives a customer (soft delete)", async () => {
    h.fakeDb.rows.set(schema.resellerCustomers, [customerRow()]);
    const res = await archiveResellerCustomer(CTX, { id: "rescus_1" });
    expect(res).toEqual({ id: "rescus_1", archived: true });
    expect(h.fakeDb.updated.some((u) => "deletedAt" in u.values)).toBe(true);
  });
});

// ── Price plans ──────────────────────────────────────────────────────────────

describe("reseller price plans", () => {
  it("creates a markup plan", async () => {
    const plan = await createResellerPricePlan(CTX, {
      name: "Std",
      pricingMode: "markup",
      markupBps: 1500,
      unitPriceCents: null,
      currency: "usd",
    });
    expect(plan.pricingMode).toBe("markup");
    expect(plan.markupBps).toBe(1500);
    expect(plan.unitPriceCents).toBeNull();
  });

  it("creates a per_unit plan (nulls the markup)", async () => {
    const plan = await createResellerPricePlan(CTX, {
      name: "PerUnit",
      pricingMode: "per_unit",
      markupBps: null,
      unitPriceCents: 3,
      currency: "usd",
    });
    expect(plan.unitPriceCents).toBe(3);
    expect(plan.markupBps).toBeNull();
  });

  it("lists plans", async () => {
    h.fakeDb.rows.set(schema.resellerPricePlans, [planRow()]);
    const plans = await listResellerPricePlans(CTX);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.name).toBe("20% markup");
  });

  it("updates a plan and enforces the mode↔rate invariant", async () => {
    h.fakeDb.rows.set(schema.resellerPricePlans, [planRow()]);
    const updated = await updateResellerPricePlan(CTX, {
      id: "resplan_1",
      name: "Renamed",
    });
    expect(updated.name).toBe("Renamed");
  });

  it("throws switching to markup without a markupBps", async () => {
    h.fakeDb.rows.set(schema.resellerPricePlans, [
      planRow({ pricingMode: "per_unit", markupBps: null, unitPriceCents: 5 }),
    ]);
    await expect(
      updateResellerPricePlan(CTX, {
        id: "resplan_1",
        pricingMode: "markup",
        markupBps: null,
      }),
    ).rejects.toThrow(/markup plans require markupBps/);
  });
});

// ── Attribution rules ────────────────────────────────────────────────────────

describe("reseller attribution rules", () => {
  it("creates a rule bound to a customer", async () => {
    h.fakeDb.rows.set(schema.resellerCustomers, [customerRow()]);
    const rule = await saveResellerAttributionRule(CTX, {
      matchKind: "workspace",
      matchValue: "ws-1",
      matchLabel: "Acme WS",
      customerId: "rescus_1",
      priority: 10,
    });
    expect(rule.matchLabel).toBe("Acme WS");
    expect(rule.customerId).toBe("rescus_1");
    expect(rule.customerName).toBe("Acme");
  });

  it("throws saving a rule for a missing customer", async () => {
    h.fakeDb.rows.set(schema.resellerCustomers, []);
    await expect(
      saveResellerAttributionRule(CTX, {
        matchKind: "capability",
        matchValue: "run_agent",
        matchLabel: "Runs",
        customerId: "rescus_missing",
        priority: 100,
      }),
    ).rejects.toThrow(/customer not found/);
  });

  it("updates an existing rule", async () => {
    h.fakeDb.rows.set(schema.resellerCustomers, [customerRow()]);
    h.fakeDb.rows.set(schema.resellerAttributionRules, [
      {
        id: "rule-int-1",
        publicId: "resrule_1",
        matchKind: "workspace",
        matchValue: "ws-1",
        matchLabel: "Old",
        customerId: "cust-int-1",
        priority: 100,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ]);
    const rule = await saveResellerAttributionRule(CTX, {
      id: "resrule_1",
      matchKind: "workspace",
      matchValue: "ws-1",
      matchLabel: "New label",
      customerId: "rescus_1",
      priority: 5,
    });
    expect(rule.matchLabel).toBe("New label");
  });

  it("lists rules resolved to customer names", async () => {
    h.fakeDb.rows.set(schema.resellerCustomers, [customerRow()]);
    h.fakeDb.rows.set(schema.resellerAttributionRules, [
      {
        id: "rule-int-1",
        publicId: "resrule_1",
        matchKind: "capability",
        matchValue: "run_agent",
        matchLabel: "Agent runs",
        customerId: "cust-int-1",
        priority: 20,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ]);
    const rules = await listResellerAttributionRules(CTX, {});
    expect(rules[0]!.customerName).toBe("Acme");
    expect(rules[0]!.matchKind).toBe("capability");
  });

  it("deletes a rule (soft)", async () => {
    h.fakeDb.rows.set(schema.resellerAttributionRules, [
      {
        id: "rule-int-1",
        publicId: "resrule_1",
        customerId: "cust-int-1",
        matchKind: "workspace",
        matchValue: "ws",
        matchLabel: "l",
        priority: 1,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ]);
    const res = await deleteResellerAttributionRule(CTX, { id: "resrule_1" });
    expect(res).toEqual({ id: "resrule_1", deleted: true });
  });
});

// ── Stripe connection ────────────────────────────────────────────────────────

describe("reseller stripe connection", () => {
  it("stores a key (insert) and reports last4", async () => {
    h.fakeDb.rows.set(schema.resellerSettings, []);
    const res = await configureResellerStripe(CTX, {
      secretKey: "sk_live_abcd1234",
      accountLabel: "Acct",
    });
    expect(res).toEqual({
      connected: true,
      accountLabel: "Acct",
      keyLast4: "1234",
    });
    expect(
      h.fakeDb.inserted.some((i) => i.table === schema.resellerSettings),
    ).toBe(true);
  });

  it("updates an existing key row on reconnect", async () => {
    h.fakeDb.rows.set(schema.resellerSettings, [
      {
        id: "s1",
        publicId: "resset_1",
        orgId: "org-1",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await configureResellerStripe(CTX, { secretKey: "sk_live_wxyz9999" });
    expect(
      h.fakeDb.updated.some((u) => u.table === schema.resellerSettings),
    ).toBe(true);
  });

  it("reports connected status only when ciphertext is present", async () => {
    h.fakeDb.rows.set(schema.resellerSettings, [
      {
        stripeSecretCiphertext: Buffer.from("x"),
        stripeSecretLast4: "9999",
        stripeAccountLabel: "Acct",
        updatedAt: now,
      },
    ]);
    const status = await getResellerStripeStatus(CTX);
    expect(status.connected).toBe(true);
    expect(status.keyLast4).toBe("9999");

    h.fakeDb.rows.set(schema.resellerSettings, []);
    const none = await getResellerStripeStatus(CTX);
    expect(none.connected).toBe(false);
    expect(none.keyLast4).toBeNull();
  });
});

// ── Preview + push ────────────────────────────────────────────────────────────

function seedForRebill() {
  h.fakeDb.rows.set(schema.resellerPricePlans, [planRow()]);
  h.fakeDb.rows.set(schema.resellerCustomers, [customerRow()]);
  h.fakeDb.rows.set(schema.resellerAttributionRules, [
    {
      id: "rule-int-1",
      publicId: "resrule_1",
      matchKind: "workspace",
      matchValue: "ws-1",
      matchLabel: "Acme WS",
      customerId: "cust-int-1",
      priority: 10,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
  ]);
}

const PERIOD = {
  start: "2026-07-01T00:00:00.000Z",
  end: "2026-07-10T00:00:00.000Z",
};

describe("preview + push", () => {
  it("previews a single customer's priced usage", async () => {
    seedForRebill();
    h.readSlicesMock.mockResolvedValue([
      {
        workspaceId: "ws-1",
        principalId: "p1",
        principalKind: "human",
        capabilityName: "run_agent",
        costMicros: 1_000_000,
        executions: 4,
      },
    ]);
    const out = await previewResellerRebill(CTX, {
      ...PERIOD,
      customerId: "rescus_1",
    });
    expect(out.previews).toHaveLength(1);
    expect(out.previews[0]!.totalCents).toBe(120); // 100c ×1.2
  });

  it("push fails (recorded) when the customer has no plan", async () => {
    seedForRebill();
    h.fakeDb.rows.set(schema.resellerCustomers, [
      customerRow({ pricePlanId: null }),
    ]);
    h.fakeDb.rows.set(schema.resellerRebillRuns, []);
    h.readSlicesMock.mockResolvedValue([]);
    const res = await pushResellerRebill(CTX, {
      customerId: "rescus_1",
      ...PERIOD,
      finalize: true,
    });
    expect(res.needsStripeConnection).toBe(false);
    expect(res.run.status).toBe("failed");
    expect(res.run.error).toMatch(/price plan/);
    expect(h.createExternalInvoiceMock).not.toHaveBeenCalled();
  });

  it("push reports needsStripeConnection when no key is configured", async () => {
    seedForRebill();
    h.fakeDb.rows.set(schema.resellerRebillRuns, []);
    h.fakeDb.rows.set(schema.resellerSettings, []);
    h.readSlicesMock.mockResolvedValue([
      {
        workspaceId: "ws-1",
        principalId: "p1",
        principalKind: "human",
        capabilityName: "run_agent",
        costMicros: 1_000_000,
        executions: 4,
      },
    ]);
    const res = await pushResellerRebill(CTX, {
      customerId: "rescus_1",
      ...PERIOD,
      finalize: true,
    });
    expect(res.needsStripeConnection).toBe(true);
    expect(res.run.status).toBe("failed");
    expect(h.createExternalInvoiceMock).not.toHaveBeenCalled();
  });

  it("push creates an invoice and records a pushed run", async () => {
    seedForRebill();
    h.fakeDb.rows.set(schema.resellerRebillRuns, []);
    h.fakeDb.rows.set(schema.resellerSettings, [
      {
        stripeSecretCiphertext: Buffer.from("cipher"),
        stripeSecretKeyId: "billing:reseller:env:v1",
      },
    ]);
    h.readSlicesMock.mockResolvedValue([
      {
        workspaceId: "ws-1",
        principalId: "p1",
        principalKind: "human",
        capabilityName: "run_agent",
        costMicros: 1_000_000,
        executions: 4,
      },
    ]);
    h.createExternalInvoiceMock.mockResolvedValue({
      providerCustomerId: "cus_stripe_1",
      invoice: {
        providerInvoiceId: "in_1",
        hostedInvoiceUrl: "https://pay/in_1",
      },
    });
    const res = await pushResellerRebill(CTX, {
      customerId: "rescus_1",
      ...PERIOD,
      finalize: true,
    });
    expect(h.createExternalInvoiceMock).toHaveBeenCalledOnce();
    expect(res.needsStripeConnection).toBe(false);
    expect(res.run.status).toBe("pushed");
    expect(res.run.providerInvoiceId).toBe("in_1");
    expect(res.run.hostedInvoiceUrl).toBe("https://pay/in_1");
  });

  it("push records a failed run when the provider throws", async () => {
    seedForRebill();
    h.fakeDb.rows.set(schema.resellerRebillRuns, []);
    h.fakeDb.rows.set(schema.resellerSettings, [
      {
        stripeSecretCiphertext: Buffer.from("cipher"),
        stripeSecretKeyId: "billing:reseller:env:v1",
      },
    ]);
    h.readSlicesMock.mockResolvedValue([
      {
        workspaceId: "ws-1",
        principalId: "p1",
        principalKind: "human",
        capabilityName: "run_agent",
        costMicros: 1_000_000,
        executions: 4,
      },
    ]);
    h.createExternalInvoiceMock.mockRejectedValue(new Error("card_declined"));
    const res = await pushResellerRebill(CTX, {
      customerId: "rescus_1",
      ...PERIOD,
      finalize: true,
    });
    expect(res.run.status).toBe("failed");
    expect(res.run.error).toMatch(/card_declined/);
  });

  it("push is idempotent: an already-pushed run is returned without a second invoice", async () => {
    seedForRebill();
    h.fakeDb.rows.set(schema.resellerRebillRuns, [
      {
        id: "run-int-1",
        publicId: "resrun_1",
        customerId: "cust-int-1",
        periodStart: new Date(PERIOD.start),
        periodEnd: new Date(PERIOD.end),
        currency: "usd",
        subtotalCents: 100,
        totalCents: 120,
        providerInvoiceId: "in_existing",
        hostedInvoiceUrl: "https://pay/in_existing",
        status: "pushed",
        error: null,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    h.fakeDb.rows.set(schema.resellerRebillLineItems, []);
    const res = await pushResellerRebill(CTX, {
      customerId: "rescus_1",
      ...PERIOD,
      finalize: true,
    });
    expect(res.run.status).toBe("pushed");
    expect(res.run.providerInvoiceId).toBe("in_existing");
    expect(h.createExternalInvoiceMock).not.toHaveBeenCalled();
    expect(h.readSlicesMock).not.toHaveBeenCalled();
  });

  it("lists rebill runs resolved to customer names + line items", async () => {
    h.fakeDb.rows.set(schema.resellerCustomers, [customerRow()]);
    h.fakeDb.rows.set(schema.resellerRebillRuns, [
      {
        id: "run-int-1",
        publicId: "resrun_1",
        customerId: "cust-int-1",
        periodStart: new Date(PERIOD.start),
        periodEnd: new Date(PERIOD.end),
        currency: "usd",
        subtotalCents: 100,
        totalCents: 120,
        providerInvoiceId: "in_1",
        hostedInvoiceUrl: "https://pay/in_1",
        status: "pushed",
        error: null,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    h.fakeDb.rows.set(schema.resellerRebillLineItems, [
      {
        id: "li-1",
        runId: "run-int-1",
        label: "Acme WS",
        matchKind: "workspace",
        rawCostCents: 100,
        quantity: 4,
        unitPriceCents: null,
        amountCents: 120,
      },
    ]);
    const runs = await listResellerRebillRuns(CTX, { limit: 50 });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.customerName).toBe("Acme");
    expect(runs[0]!.lineItems).toHaveLength(1);
    expect(runs[0]!.lineItems[0]!.label).toBe("Acme WS");
  });
});

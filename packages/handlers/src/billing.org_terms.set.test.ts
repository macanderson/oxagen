/**
 * Unit tests for the set_org_billing_terms handler.
 *
 * The handler has no role gate: reaching it at all is the authorization, and
 * the kernel owns that (INV-31, kernel.test.ts). What is asserted here is the
 * rest of the contract's promise — the row is keyed on the INPUT's orgId
 * rather than on any tenant the context might carry, the stored row is what
 * comes back, and the mutation is audited against the target org before the
 * handler resolves (the caller is a process that exits on return). Switching
 * invoice billing off closes the accrual before the write; what the close
 * writes is closeInvoiceAccrual's, tested in packages/billing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";

const mocks = vi.hoisted(() => ({
  emitSecurityEventAsync: vi.fn<() => Promise<void>>(async () => {}),
}));

vi.mock("@oxagen/database/security", () => ({
  emitSecurityEventAsync: mocks.emitSecurityEventAsync,
}));

import {
  createBillingOrgTermsSetHandler,
  type OrgBillingTermsDeps,
  type OrgBillingTermsWriter,
} from "./billing.org_terms.set";

const ORG = "0192d4a8-7c1e-7a00-8000-00000000ac3e";
const OTHER_ORG = "0192d4a8-7c1e-7a00-8000-00000000ac3f";

/** What an operator script builds: no tenant, no user, surface "runner". */
const operatorCtx = (): CapabilityContext => ({
  orgId: "",
  workspaceId: "",
  userId: null,
  apiKeyId: null,
  requestId: "req-operator",
  surface: "runner",
  messageId: null,
});

/** One org_billing_settings row, reduced to the two columns this handler owns. */
type StoredTerms = {
  approvedForInvoiceBilling: boolean;
  invoiceGauMax: number;
};

function makeStore(seed: Record<string, StoredTerms> = {}) {
  const rows = new Map(Object.entries(seed));
  const log: string[] = [];
  const write: OrgBillingTermsWriter = async (terms) => {
    log.push("write");
    rows.set(terms.orgId, {
      approvedForInvoiceBilling: terms.approvedForInvoiceBilling,
      invoiceGauMax: terms.invoiceGauMax,
    });
    return terms;
  };
  const deps: OrgBillingTermsDeps = {
    // An org with no row is on the column default: prepaid.
    current: async (orgId) => ({
      approvedForInvoiceBilling:
        rows.get(orgId)?.approvedForInvoiceBilling ?? false,
    }),
    write: vi.fn(write),
    closeAccrual: vi.fn(async () => {
      log.push("closeAccrual");
      return null;
    }),
  };
  return { rows, log, deps, write: deps.write };
}

describe("set_org_billing_terms handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.emitSecurityEventAsync.mockResolvedValue(undefined);
  });

  it("approves an org for invoice billing and returns the stored row", async () => {
    const store = makeStore();
    const handler = createBillingOrgTermsSetHandler(store.deps);

    const out = await handler(
      {
        orgId: ORG,
        approvedForInvoiceBilling: true,
        invoiceGauMax: 250_000,
      },
      operatorCtx(),
    );

    expect(out).toEqual({
      orgId: ORG,
      approvedForInvoiceBilling: true,
      invoiceGauMax: 250_000,
    });
    expect(store.rows.get(ORG)).toEqual({
      approvedForInvoiceBilling: true,
      invoiceGauMax: 250_000,
    });
  });

  it("returns an org to prepaid", async () => {
    const store = makeStore({
      [ORG]: { approvedForInvoiceBilling: true, invoiceGauMax: 250_000 },
    });
    const handler = createBillingOrgTermsSetHandler(store.deps);

    await handler(
      {
        orgId: ORG,
        approvedForInvoiceBilling: false,
        invoiceGauMax: 250_000,
      },
      operatorCtx(),
    );

    expect(store.rows.get(ORG)?.approvedForInvoiceBilling).toBe(false);
  });

  it("stores the ceiling for an unapproved org, where it is inert", async () => {
    const store = makeStore();
    const handler = createBillingOrgTermsSetHandler(store.deps);

    const out = await handler(
      {
        orgId: ORG,
        approvedForInvoiceBilling: false,
        invoiceGauMax: 1,
      },
      operatorCtx(),
    );

    expect(out.invoiceGauMax).toBe(1);
    expect(store.rows.get(ORG)?.invoiceGauMax).toBe(1);
  });

  it("keys the row on the input's org, not on any tenant in the context", async () => {
    const store = makeStore();
    const handler = createBillingOrgTermsSetHandler(store.deps);

    await handler(
      {
        orgId: ORG,
        approvedForInvoiceBilling: true,
        invoiceGauMax: 10,
      },
      { ...operatorCtx(), orgId: OTHER_ORG },
    );

    expect(store.write).toHaveBeenCalledWith({
      orgId: ORG,
      approvedForInvoiceBilling: true,
      invoiceGauMax: 10,
    });
    expect(store.rows.has(OTHER_ORG)).toBe(false);
  });

  it("audits the mutation against the target org with no acting user", async () => {
    const store = makeStore();
    const handler = createBillingOrgTermsSetHandler(store.deps);

    await handler(
      {
        orgId: ORG,
        approvedForInvoiceBilling: true,
        invoiceGauMax: 10,
      },
      operatorCtx(),
    );

    expect(mocks.emitSecurityEventAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "set_org_billing_terms",
        orgId: ORG,
        actorUserId: null,
        requestId: "req-operator",
        outcome: "success",
      }),
    );
  });

  it("does not resolve until the audit row is written", async () => {
    let releaseAudit: () => void = () => {};
    mocks.emitSecurityEventAsync.mockReturnValue(
      new Promise<void>((resolve) => {
        releaseAudit = resolve;
      }),
    );
    const store = makeStore();
    const handler = createBillingOrgTermsSetHandler(store.deps);

    let resolved = false;
    const run = handler(
      { orgId: ORG, approvedForInvoiceBilling: true, invoiceGauMax: 10 },
      operatorCtx(),
    ).then(() => {
      resolved = true;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(store.write).toHaveBeenCalledOnce();
    expect(mocks.emitSecurityEventAsync).toHaveBeenCalledOnce();
    expect(resolved).toBe(false);

    releaseAudit();
    await run;
    expect(resolved).toBe(true);
  });

  it("fails when the audit row cannot be written, after the terms are stored", async () => {
    mocks.emitSecurityEventAsync.mockRejectedValue(
      new Error("security_events insert failed after 3 attempts"),
    );
    const store = makeStore();
    const handler = createBillingOrgTermsSetHandler(store.deps);

    await expect(
      handler(
        { orgId: ORG, approvedForInvoiceBilling: true, invoiceGauMax: 10 },
        operatorCtx(),
      ),
    ).rejects.toThrow(/security_events insert failed/);
    expect(store.rows.get(ORG)?.approvedForInvoiceBilling).toBe(true);
  });

  it("does not audit a write that failed", async () => {
    const failing: OrgBillingTermsWriter = async () => {
      throw new Error("foreign key violated: no such org");
    };
    const handler = createBillingOrgTermsSetHandler({
      ...makeStore().deps,
      write: failing,
    });

    await expect(
      handler(
        { orgId: ORG, approvedForInvoiceBilling: true, invoiceGauMax: 10 },
        operatorCtx(),
      ),
    ).rejects.toThrow();
    expect(mocks.emitSecurityEventAsync).not.toHaveBeenCalled();
  });

  it("closes the accrual before the write when it switches invoice billing off", async () => {
    const store = makeStore({
      [ORG]: { approvedForInvoiceBilling: true, invoiceGauMax: 250_000 },
    });
    const handler = createBillingOrgTermsSetHandler(store.deps);

    await handler(
      { orgId: ORG, approvedForInvoiceBilling: false, invoiceGauMax: 250_000 },
      operatorCtx(),
    );

    expect(store.deps.closeAccrual).toHaveBeenCalledOnce();
    expect(store.deps.closeAccrual).toHaveBeenCalledWith(ORG);
    expect(store.log).toEqual(["closeAccrual", "write"]);
  });

  it("closes no accrual when it switches invoice billing on", async () => {
    const store = makeStore();
    const handler = createBillingOrgTermsSetHandler(store.deps);

    await handler(
      { orgId: ORG, approvedForInvoiceBilling: true, invoiceGauMax: 250_000 },
      operatorCtx(),
    );

    expect(store.deps.closeAccrual).not.toHaveBeenCalled();
  });

  it("closes no accrual for a prepaid org that stays prepaid", async () => {
    const store = makeStore({
      [ORG]: { approvedForInvoiceBilling: false, invoiceGauMax: 250_000 },
    });
    const handler = createBillingOrgTermsSetHandler(store.deps);

    await handler(
      { orgId: ORG, approvedForInvoiceBilling: false, invoiceGauMax: 1 },
      operatorCtx(),
    );

    expect(store.deps.closeAccrual).not.toHaveBeenCalled();
  });

  it("closes no accrual for an invoice-billed org that stays invoice-billed", async () => {
    const store = makeStore({
      [ORG]: { approvedForInvoiceBilling: true, invoiceGauMax: 250_000 },
    });
    const handler = createBillingOrgTermsSetHandler(store.deps);

    await handler(
      { orgId: ORG, approvedForInvoiceBilling: true, invoiceGauMax: 500_000 },
      operatorCtx(),
    );

    expect(store.deps.closeAccrual).not.toHaveBeenCalled();
  });

  it("writes nothing when closing the accrual fails, so a re-run still sees the org invoice-billed", async () => {
    const store = makeStore({
      [ORG]: { approvedForInvoiceBilling: true, invoiceGauMax: 250_000 },
    });
    vi.mocked(store.deps.closeAccrual).mockRejectedValueOnce(
      new Error("connection reset"),
    );
    const handler = createBillingOrgTermsSetHandler(store.deps);

    await expect(
      handler(
        {
          orgId: ORG,
          approvedForInvoiceBilling: false,
          invoiceGauMax: 250_000,
        },
        operatorCtx(),
      ),
    ).rejects.toThrow("connection reset");
    expect(store.write).not.toHaveBeenCalled();
    expect(store.rows.get(ORG)?.approvedForInvoiceBilling).toBe(true);
  });
});

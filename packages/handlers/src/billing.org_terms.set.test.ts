/**
 * Unit tests for the set_org_billing_terms handler.
 *
 * The handler has no role gate: reaching it at all is the authorization, and
 * the kernel owns that (INV-31, kernel.test.ts). What is asserted here is the
 * rest of the contract's promise — the row is keyed on the INPUT's orgId
 * rather than on any tenant the context might carry, the stored row is what
 * comes back, and the mutation is audited against the target org.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";

const mocks = vi.hoisted(() => ({ emitSecurityEvent: vi.fn() }));

vi.mock("@oxagen/database/security", () => ({
  emitSecurityEvent: mocks.emitSecurityEvent,
}));

import {
  createBillingOrgTermsSetHandler,
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
  const write: OrgBillingTermsWriter = async (terms) => {
    rows.set(terms.orgId, {
      approvedForInvoiceBilling: terms.approvedForInvoiceBilling,
      invoiceGauMax: terms.invoiceGauMax,
    });
    return terms;
  };
  return { rows, write: vi.fn(write) };
}

describe("set_org_billing_terms handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("approves an org for invoice billing and returns the stored row", async () => {
    const store = makeStore();
    const handler = createBillingOrgTermsSetHandler(store.write);

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
    const handler = createBillingOrgTermsSetHandler(store.write);

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
    const handler = createBillingOrgTermsSetHandler(store.write);

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
    const handler = createBillingOrgTermsSetHandler(store.write);

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
    const handler = createBillingOrgTermsSetHandler(store.write);

    await handler(
      {
        orgId: ORG,
        approvedForInvoiceBilling: true,
        invoiceGauMax: 10,
      },
      operatorCtx(),
    );

    expect(mocks.emitSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "set_org_billing_terms",
        orgId: ORG,
        actorUserId: null,
        requestId: "req-operator",
        outcome: "success",
      }),
    );
  });

  it("does not audit a write that failed", async () => {
    const failing: OrgBillingTermsWriter = async () => {
      throw new Error("foreign key violated: no such org");
    };
    const handler = createBillingOrgTermsSetHandler(failing);

    await expect(
      handler(
        { orgId: ORG, approvedForInvoiceBilling: true, invoiceGauMax: 10 },
        operatorCtx(),
      ),
    ).rejects.toThrow();
    expect(mocks.emitSecurityEvent).not.toHaveBeenCalled();
  });
});

/**
 * Unit tests for the create_prepaid_invoice handler.
 *
 * No role gate to test: reaching the handler is the authorization, and the
 * kernel owns that (INV-31; the contract test proves the refusal). What is
 * asserted here: the defaults the order takes from the org's negotiated
 * terms, the order id as the resume key, the refusals keeping their meaning,
 * the awaited audit row, and the output built from the stored order. The
 * order sequence itself (draft row, invoice, grant) is prepaid-orders.ts's,
 * tested in packages/billing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { isHandlerError, type CapabilityContext } from "@oxagen/oxagen";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import { billingPrepaidInvoiceCreate } from "@oxagen/oxagen/contracts/billing.prepaid_invoice.create";
import {
  PrepaidOrderError,
  type PrepaidOrderDefaults,
  type PrepaidOrderRow,
  type PrepaidOrderSpec,
} from "@oxagen/billing";

const mocks = vi.hoisted(() => ({
  emitSecurityEventAsync: vi.fn<() => Promise<void>>(async () => {}),
}));

vi.mock("@oxagen/database/security", () => ({
  emitSecurityEventAsync: mocks.emitSecurityEventAsync,
}));

import {
  createBillingPrepaidInvoiceCreateHandler,
  type PrepaidInvoiceDeps,
} from "./billing.prepaid_invoice.create";

const ORG = "0192d4a8-7c1e-7a00-8000-00000000e001";
const ORDER = "0192d4a8-7c1e-7a00-8000-0000000000d1";
const MINTED = "0192d4a8-7c1e-7a00-8000-0000000000d2";

const operatorCtx = (): CapabilityContext => ({
  orgId: "",
  workspaceId: "",
  userId: null,
  apiKeyId: null,
  requestId: "req-operator",
  surface: "runner",
  messageId: null,
});

const NEGOTIATED: PrepaidOrderDefaults = {
  currency: "usd",
  agreementRef: "MSA-2026-014",
  ratePerGauMicros: 3_000n,
};

function rowOf(id: string, spec: PrepaidOrderSpec): PrepaidOrderRow {
  return {
    id,
    orgId: spec.orgId,
    agreementRef: spec.agreementRef,
    poNumber: spec.poNumber,
    currency: spec.currency,
    licenceCents: spec.licence?.amountCents ?? 0,
    licencePeriodStart: spec.licence?.periodStart ?? null,
    licencePeriodEnd: spec.licence?.periodEnd ?? null,
    gauQuantity: spec.gau?.quantity ?? 0,
    ratePerGauMicros: spec.gau?.ratePerGauMicros ?? 0n,
    creditCents: spec.creditCents,
    grantOn: spec.grantOn,
    status: "open",
    daysUntilDue: spec.daysUntilDue,
    memo: spec.memo,
    stripeInvoiceId: "in_pre_001",
    grantedBucketId: null,
    unitsGrantedAt: null,
    creditsGrantedAt: null,
    issuedByRequestId: "req-operator",
    createdAt: new Date("2026-09-23T12:00:00.000Z"),
    updatedAt: new Date("2026-09-23T12:00:00.000Z"),
    paidAt: null,
  };
}

function makeDeps(
  opts: { defaults?: PrepaidOrderDefaults; created?: boolean } = {},
) {
  const specs: PrepaidOrderSpec[] = [];
  const deps: PrepaidInvoiceDeps = {
    defaults: vi.fn(async () => opts.defaults ?? NEGOTIATED),
    open: vi.fn(async ({ id, spec }) => {
      specs.push(spec);
      return { order: rowOf(id, spec), created: opts.created ?? true };
    }),
    invoice: vi.fn(async (id: string) => ({
      order: rowOf(id, specs.at(-1)!),
      invoice: {
        status: "open" as const,
        number: "OXA-0042",
        hostedInvoiceUrl: "https://invoice.stripe.com/i/pre",
        invoicePdfUrl: "https://invoice.stripe.com/i/pre.pdf",
        amountDueCents: 13_100_000,
        assistantSpendCap: { kind: "unchanged" as const },
      },
      grant: null,
    })),
    newOrderId: () => MINTED,
  };
  return { deps, specs };
}

const input = (over: Record<string, unknown> = {}) =>
  billingPrepaidInvoiceCreate.input.parse({
    orgId: ORG,
    poNumber: "PO-7781",
    licence: {
      amountCents: 12_000_000,
      periodStart: "2026-10-01T00:00:00.000Z",
      periodEnd: "2027-10-01T00:00:00.000Z",
    },
    gau: { quantity: 2_000_000 },
    creditsCents: 500_000,
    ...over,
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.emitSecurityEventAsync.mockResolvedValue(undefined);
});

describe("create_prepaid_invoice handler", () => {
  it("takes the currency, agreement and rate from the negotiated terms, mints an order id, and returns the order as issued", async () => {
    const { deps, specs } = makeDeps();

    const out = await createBillingPrepaidInvoiceCreateHandler(deps)(
      input(),
      operatorCtx(),
    );

    expect(deps.defaults).toHaveBeenCalledWith(ORG);
    expect(specs[0]).toEqual({
      orgId: ORG,
      agreementRef: "MSA-2026-014",
      poNumber: "PO-7781",
      currency: "usd",
      licence: {
        amountCents: 12_000_000,
        periodStart: new Date("2026-10-01T00:00:00.000Z"),
        periodEnd: new Date("2027-10-01T00:00:00.000Z"),
      },
      gau: { quantity: 2_000_000, ratePerGauMicros: 3_000n },
      creditCents: 500_000,
      daysUntilDue: 30,
      grantOn: "paid",
      memo: null,
      assistantSpendCap: { kind: "unchanged" },
    });
    expect(deps.open).toHaveBeenCalledWith(
      expect.objectContaining({
        id: MINTED,
        issuedByRequestId: "req-operator",
      }),
    );
    expect(deps.invoice).toHaveBeenCalledWith(MINTED, {
      assistantSpendCap: { kind: "unchanged" },
    });
    expect(out).toMatchObject({
      orderId: MINTED,
      orgId: ORG,
      resumed: false,
      status: "open",
      agreementRef: "MSA-2026-014",
      currency: "usd",
      totalMicros: "131000000000",
      stripeInvoiceId: "in_pre_001",
      invoiceNumber: "OXA-0042",
      grant: null,
    });
    expect(out.lines.map((l) => l.kind)).toEqual(["licence", "gau", "credits"]);
    expect(() => billingPrepaidInvoiceCreate.output.parse(out)).not.toThrow();
  });

  it("resumes the order the input names, and says so", async () => {
    const { deps } = makeDeps({ created: false });
    const out = await createBillingPrepaidInvoiceCreateHandler(deps)(
      input({ orderId: ORDER }),
      operatorCtx(),
    );
    expect(deps.open).toHaveBeenCalledWith(
      expect.objectContaining({ id: ORDER }),
    );
    expect(out).toMatchObject({ orderId: ORDER, resumed: true });
  });

  it("passes the assistant cap on as an instruction, null meaning no cap", async () => {
    const { deps, specs } = makeDeps();
    await createBillingPrepaidInvoiceCreateHandler(deps)(
      input({ assistantSpendCapCents: null }),
      operatorCtx(),
    );
    expect(specs[0]!.assistantSpendCap).toEqual({
      kind: "set",
      capCents: null,
    });
    expect(deps.invoice).toHaveBeenCalledWith(MINTED, {
      assistantSpendCap: { kind: "set", capCents: null },
    });
  });

  it("uses an explicit rate, agreement and currency over the defaults", async () => {
    const { deps, specs } = makeDeps();
    await createBillingPrepaidInvoiceCreateHandler(deps)(
      input({
        agreementRef: "SOW-9",
        currency: "eur",
        gau: { quantity: 10_000, ratePerGauMicros: "2500" },
      }),
      operatorCtx(),
    );
    expect(specs[0]).toMatchObject({
      agreementRef: "SOW-9",
      currency: "eur",
      gau: { quantity: 10_000, ratePerGauMicros: 2_500n },
    });
  });

  it("refuses units with no rate for an org on published terms, before writing anything", async () => {
    const { deps } = makeDeps({
      defaults: { currency: "usd", agreementRef: null, ratePerGauMicros: null },
    });
    const err = await createBillingPrepaidInvoiceCreateHandler(deps)(
      input(),
      operatorCtx(),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CapabilityError);
    expect(err).toMatchObject({ code: "invalid_input" });
    expect((err as Error).message).toMatch(/gau_rate_required/);
    expect(deps.open).not.toHaveBeenCalled();
  });

  it("refuses the contracted rate for an order in another currency", async () => {
    const { deps } = makeDeps();
    await expect(
      createBillingPrepaidInvoiceCreateHandler(deps)(
        input({ currency: "eur" }),
        operatorCtx(),
      ),
    ).rejects.toThrow(/contracted rate is in usd and the order is in eur/);
    expect(deps.open).not.toHaveBeenCalled();
  });

  it("orders a licence alone with no rate at all", async () => {
    const { deps, specs } = makeDeps({
      defaults: { currency: "usd", agreementRef: null, ratePerGauMicros: null },
    });
    await createBillingPrepaidInvoiceCreateHandler(deps)(
      input({ gau: undefined, creditsCents: undefined }),
      operatorCtx(),
    );
    expect(specs[0]).toMatchObject({
      gau: null,
      creditCents: 0,
      agreementRef: null,
    });
  });

  it.each([
    [
      new PrepaidOrderError(
        "invalid_prepaid_order",
        "gau_not_whole_cents",
        "not whole cents",
      ),
      { code: "invalid_input" },
    ],
    [
      new PrepaidOrderError(
        "prepaid_order_conflict",
        "order_id_reused",
        "different lines",
      ),
      { code: "conflict", reason: "order_id_reused" },
    ],
    [
      new PrepaidOrderError("prepaid_order_closed", "void", "void"),
      { code: "conflict", reason: "void" },
    ],
    [
      new PrepaidOrderError("prepaid_order_not_found", "no_order", "none"),
      { code: "not_found", reason: "no_order" },
    ],
  ])("surfaces the billing refusal %#", async (thrown, expected) => {
    const { deps } = makeDeps();
    vi.mocked(deps.open).mockRejectedValueOnce(thrown);
    const err = await createBillingPrepaidInvoiceCreateHandler(deps)(
      input(),
      operatorCtx(),
    ).catch((e: unknown) => e);
    expect(err).toMatchObject(expected);
    if (expected.code !== "invalid_input")
      expect(isHandlerError(err)).toBe(true);
    expect(mocks.emitSecurityEventAsync).not.toHaveBeenCalled();
  });

  it("rethrows a provider failure unchanged, with the order id logged for the resume", async () => {
    const { deps } = makeDeps();
    vi.mocked(deps.invoice).mockRejectedValueOnce(
      new Error("stripe unreachable"),
    );
    await expect(
      createBillingPrepaidInvoiceCreateHandler(deps)(input(), operatorCtx()),
    ).rejects.toThrow("stripe unreachable");
    expect(mocks.emitSecurityEventAsync).not.toHaveBeenCalled();
  });

  it("awaits a billing.plan_changed audit row against the target org before it resolves", async () => {
    let release: () => void = () => {};
    mocks.emitSecurityEventAsync.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const { deps } = makeDeps();
    let resolved = false;
    const run = createBillingPrepaidInvoiceCreateHandler(deps)(
      input(),
      operatorCtx(),
    ).then(() => {
      resolved = true;
    });

    await vi.waitFor(() =>
      expect(mocks.emitSecurityEventAsync).toHaveBeenCalledOnce(),
    );
    expect(mocks.emitSecurityEventAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "billing.plan_changed",
        capability: "create_prepaid_invoice",
        orgId: ORG,
        actorUserId: null,
        requestId: "req-operator",
      }),
    );
    expect(resolved).toBe(false);
    release();
    await run;
    expect(resolved).toBe(true);
  });

  it("reports an issue-time grant", async () => {
    const { deps } = makeDeps();
    vi.mocked(deps.invoice).mockImplementationOnce(async (id: string) => ({
      order: rowOf(id, {
        orgId: ORG,
        agreementRef: null,
        poNumber: null,
        currency: "usd",
        licence: null,
        gau: null,
        creditCents: 500_000,
        daysUntilDue: 30,
        grantOn: "issue",
        memo: null,
        assistantSpendCap: { kind: "set", capCents: 600_000 },
      }),
      invoice: {
        status: "open",
        number: "OXA-0043",
        hostedInvoiceUrl: null,
        invoicePdfUrl: null,
        amountDueCents: 500_000,
        assistantSpendCap: { kind: "set", capCents: 600_000 },
      },
      grant: {
        orderId: id,
        orgId: ORG,
        unitsGranted: 0,
        creditsGranted: 500_000,
        assistantSpendCapCents: 600_000,
        bucketId: null,
        status: "open",
      },
    }));
    const out = await createBillingPrepaidInvoiceCreateHandler(deps)(
      input({ grantOn: "issue", assistantSpendCapCents: 600_000 }),
      operatorCtx(),
    );
    expect(out.grant).toEqual({
      unitsGranted: 0,
      creditsGrantedCents: 500_000,
      assistantSpendCapCents: 600_000,
    });
  });
});

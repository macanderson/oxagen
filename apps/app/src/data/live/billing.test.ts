// The billing port: six kernel reads on the organization's ctx, each mapped
// into its view model, with a refusal passed through and an unmappable record
// reported once.
import { billingContractRateGet } from "@oxagen/oxagen/contracts/billing.contract_rate.get";
import { billingEvidenceRetention } from "@oxagen/oxagen/contracts/billing.evidence_retention";
import { billingGauBucketGet } from "@oxagen/oxagen/contracts/billing.gau_bucket.get";
import { billingInvoiceList } from "@oxagen/oxagen/contracts/billing.invoice.list";
import { billingSubscriptionRead } from "@oxagen/oxagen/contracts/billing.subscription.read";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  contractRateOutput,
  evidenceRetentionOutput,
  invoiceItemOutput,
  prepaidBucketOutput,
  subscriptionOutput,
} from "@/test/billing-outputs";

const { kernelRead, captureError } = vi.hoisted(() => ({
  kernelRead: vi.fn(),
  captureError: vi.fn(),
}));
vi.mock("@/server/kernel", () => ({ kernelRead }));
vi.mock("@oxagen/telemetry", () => ({ captureError }));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { OrgCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { readError, readOk } = await import("@/data/read");
const { billing } = await import("./billing");

const ctx = unsafeMint(OrgCtx, {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "billing",
});

const DENIED = {
  ok: false,
  reason: "denied",
  permission: "org.billing",
} as const;

beforeEach(() => {
  kernelRead.mockReset();
  captureError.mockReset();
});

describe("billing.plan", () => {
  it("reads get_subscription and keeps the subscription alone", async () => {
    kernelRead.mockResolvedValue(readOk(subscriptionOutput()));
    const read = await billing.plan(ctx);
    expect(read).toEqual(
      readOk({
        subscription: {
          plan: "build",
          status: "active",
          billingInterval: "month",
          currentPeriodStart: "2026-09-01T00:00:00.000Z",
          currentPeriodEnd: "2026-10-01T00:00:00.000Z",
        },
      }),
    );
    expect(JSON.stringify(read)).not.toMatch(/credit|cost|token/i);
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: billingSubscriptionRead,
      input: {},
      page: "billing",
    });
  });

  it("passes a denial through untouched (negative)", async () => {
    kernelRead.mockResolvedValue(DENIED);
    expect(await billing.plan(ctx)).toEqual(DENIED);
    expect(captureError).not.toHaveBeenCalled();
  });

  it("answers record_unmappable and reports once for a subscription the view model refuses (negative)", async () => {
    const out = subscriptionOutput();
    kernelRead.mockResolvedValue(
      readOk({
        ...out,
        subscription: out.subscription && {
          ...out.subscription,
          planSlug: "",
        },
      }),
    );
    expect(await billing.plan(ctx)).toEqual(
      readError("record_unmappable", 502),
    );
    expect(captureError).toHaveBeenCalledOnce();
  });
});

describe("billing.usageCredits", () => {
  it("reads get_subscription into the credit balance and its face value", async () => {
    kernelRead.mockResolvedValue(readOk(subscriptionOutput()));
    expect(await billing.usageCredits(ctx)).toEqual(
      readOk({
        balanceCredits: 4200,
        balance: { micros: "42000000", currency: "USD" },
      }),
    );
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: billingSubscriptionRead,
      input: {},
      page: "billing",
    });
  });

  it("carries no token usage into the view (negative)", async () => {
    kernelRead.mockResolvedValue(readOk(subscriptionOutput()));
    const read = await billing.usageCredits(ctx);
    expect(JSON.stringify(read)).not.toMatch(/token|cost|plan/i);
  });

  it("passes a denial through untouched (negative)", async () => {
    kernelRead.mockResolvedValue(DENIED);
    expect(await billing.usageCredits(ctx)).toEqual(DENIED);
    expect(captureError).not.toHaveBeenCalled();
  });

  it("passes an error through untouched (negative)", async () => {
    kernelRead.mockResolvedValue(readError("stripe_unreachable", 502));
    expect(await billing.usageCredits(ctx)).toEqual(
      readError("stripe_unreachable", 502),
    );
  });
});

describe("billing.bucket", () => {
  it("reads get_gau_bucket into the bucket view", async () => {
    kernelRead.mockResolvedValue(readOk(prepaidBucketOutput()));
    expect(await billing.bucket(ctx)).toEqual(readOk(prepaidBucketOutput()));
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: billingGauBucketGet,
      input: {},
      page: "billing",
    });
  });

  it("passes an error through untouched (negative)", async () => {
    kernelRead.mockResolvedValue(readError("stripe_unreachable", 502));
    expect(await billing.bucket(ctx)).toEqual(
      readError("stripe_unreachable", 502),
    );
  });

  it("answers record_unmappable for a period that is not an instant (negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk(
        prepaidBucketOutput({
          period: { start: "yesterday", end: "2026-10-01T00:00:00.000Z" },
        }),
      ),
    );
    expect(await billing.bucket(ctx)).toEqual(
      readError("record_unmappable", 502),
    );
    expect(captureError).toHaveBeenCalledOnce();
  });
});

describe("billing.contractRate", () => {
  it("reads get_contract_rate into the rate block", async () => {
    kernelRead.mockResolvedValue(readOk(contractRateOutput()));
    const read = await billing.contractRate(ctx);
    expect(read.ok && read.value.ratePerGau).toEqual({
      micros: "3210",
      currency: "USD",
    });
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: billingContractRateGet,
      input: {},
      page: "billing",
    });
  });

  it("passes a denial through untouched (negative)", async () => {
    kernelRead.mockResolvedValue(DENIED);
    expect(await billing.contractRate(ctx)).toEqual(DENIED);
  });

  it("answers record_unmappable for an empty agreement reference (negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk(contractRateOutput({ agreementRef: "" })),
    );
    expect(await billing.contractRate(ctx)).toEqual(
      readError("record_unmappable", 502),
    );
    expect(captureError).toHaveBeenCalledOnce();
  });
});

describe("billing.retention", () => {
  it("reads get_evidence_retention into the retention terms", async () => {
    kernelRead.mockResolvedValue(readOk(evidenceRetentionOutput()));
    expect(await billing.retention(ctx)).toEqual(
      readOk({
        includedMonths: 12,
        perGbMonth: { micros: "80000", currency: "USD" },
        extendedRetentionEnabled: false,
      }),
    );
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: billingEvidenceRetention,
      input: {},
      page: "billing",
    });
  });

  it("passes a denial through untouched (negative)", async () => {
    kernelRead.mockResolvedValue(DENIED);
    expect(await billing.retention(ctx)).toEqual(DENIED);
  });

  it("answers record_unmappable for a price micros cannot hold (negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk(evidenceRetentionOutput({ usdPerGbMonth: 1e-7 })),
    );
    expect(await billing.retention(ctx)).toEqual(
      readError("record_unmappable", 502),
    );
    expect(captureError).toHaveBeenCalledOnce();
  });
});

describe("billing.invoices", () => {
  it("reads the newest page with no cursor and a later page with the URL's cursor", async () => {
    kernelRead.mockResolvedValue(
      readOk({ items: [invoiceItemOutput()], nextCursor: "c3" }),
    );
    const read = await billing.invoices(ctx, { cursor: null });
    expect(read.ok && read.value.nextCursor).toBe("c3");
    expect(kernelRead).toHaveBeenLastCalledWith(ctx, {
      contract: billingInvoiceList,
      input: {},
      page: "billing",
    });
    await billing.invoices(ctx, { cursor: "c2" });
    expect(kernelRead).toHaveBeenLastCalledWith(ctx, {
      contract: billingInvoiceList,
      input: { cursor: "c2" },
      page: "billing",
    });
  });

  it("passes a denial through untouched (negative)", async () => {
    kernelRead.mockResolvedValue(DENIED);
    expect(await billing.invoices(ctx, { cursor: null })).toEqual(DENIED);
  });

  it("answers record_unmappable for an invoice id that is not a public id (negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        items: [invoiceItemOutput({ publicId: "7a000000-uuid" })],
        nextCursor: null,
      }),
    );
    expect(await billing.invoices(ctx, { cursor: null })).toEqual(
      readError("record_unmappable", 502),
    );
    expect(captureError).toHaveBeenCalledOnce();
  });
});

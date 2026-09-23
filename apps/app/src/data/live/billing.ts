// The billing port on the kernel (ARCHITECTURE.md §3.3, §3.9): the Billing
// page's six reads, each a noBillingGate kernelRead mapped into its view
// model and parsed at the boundary.
import "server-only";
import { billingContractRateGet } from "@oxagen/oxagen/contracts/billing.contract_rate.get";
import { billingEvidenceRetention } from "@oxagen/oxagen/contracts/billing.evidence_retention";
import { billingGauBucketGet } from "@oxagen/oxagen/contracts/billing.gau_bucket.get";
import { billingInvoiceList } from "@oxagen/oxagen/contracts/billing.invoice.list";
import { billingSubscriptionRead } from "@oxagen/oxagen/contracts/billing.subscription.read";
import { captureError } from "@oxagen/telemetry";
import type { z } from "zod";
import {
  ContractRate,
  EvidenceRetention,
  GauBucket,
  InvoicePage,
  PlanCard,
  UsageCredits,
} from "@/data/contracts/billing";
import type { DataSource } from "@/data/ports";
import { type Read, readError, readOk } from "@/data/read";
import { kernelRead } from "@/server/kernel";
import {
  toContractRate,
  toEvidenceRetention,
  toGauBucket,
  toInvoicePage,
  toPlanCard,
  toUsageCredits,
} from "./mappers/billing";

/** The view model parsed from a mapped record, or record_unmappable reported once. */
function parsed<T>(
  schema: z.ZodType<T>,
  record: unknown,
  orgId: string,
  method: string,
): Read<T> {
  const view = schema.safeParse(record);
  if (view.success) return readOk(view.data);
  captureError({
    error: view.error,
    source: "app",
    orgId,
    context: `billing.${method} record_unmappable`,
  });
  return readError("record_unmappable", 502);
}

export const billing: DataSource["billing"] = {
  async plan(ctx) {
    const read = await kernelRead(ctx, {
      contract: billingSubscriptionRead,
      input: {},
      page: "billing",
    });
    return read.ok
      ? parsed(PlanCard, toPlanCard(read.value), ctx.orgId, "plan")
      : read;
  },
  // The plan card and the credit balance are two mappings of one record, so
  // this repeats the read the plan made. The kernel seam serves a repeated
  // read once per request (§3.2), which is where the dedup is allowed to live:
  // INV-06 requires this method to make its own kernelRead call.
  async usageCredits(ctx) {
    const read = await kernelRead(ctx, {
      contract: billingSubscriptionRead,
      input: {},
      page: "billing",
    });
    return read.ok
      ? parsed(
          UsageCredits,
          toUsageCredits(read.value),
          ctx.orgId,
          "usageCredits",
        )
      : read;
  },
  async bucket(ctx) {
    const read = await kernelRead(ctx, {
      contract: billingGauBucketGet,
      input: {},
      page: "billing",
    });
    return read.ok
      ? parsed(GauBucket, toGauBucket(read.value), ctx.orgId, "bucket")
      : read;
  },
  async contractRate(ctx) {
    const read = await kernelRead(ctx, {
      contract: billingContractRateGet,
      input: {},
      page: "billing",
    });
    return read.ok
      ? parsed(
          ContractRate,
          toContractRate(read.value),
          ctx.orgId,
          "contractRate",
        )
      : read;
  },
  async retention(ctx) {
    const read = await kernelRead(ctx, {
      contract: billingEvidenceRetention,
      input: {},
      page: "billing",
    });
    return read.ok
      ? parsed(
          EvidenceRetention,
          toEvidenceRetention(read.value),
          ctx.orgId,
          "retention",
        )
      : read;
  },
  async invoices(ctx, q) {
    const read = await kernelRead(ctx, {
      contract: billingInvoiceList,
      input: q.cursor === null ? {} : { cursor: q.cursor },
      page: "billing",
    });
    return read.ok
      ? parsed(InvoicePage, toInvoicePage(read.value), ctx.orgId, "invoices")
      : read;
  },
};

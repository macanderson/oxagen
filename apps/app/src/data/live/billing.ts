// The billing port on the kernel (ARCHITECTURE.md §3.3, §3.9): the Billing
// page's five reads, each a noBillingGate kernelRead mapped into its view
// model and parsed at the boundary.
import "server-only";
import { billingContractRateGet } from "@oxagen/oxagen/contracts/billing.contract_rate.get";
import { billingGauBucketGet } from "@oxagen/oxagen/contracts/billing.gau_bucket.get";
import { billingInvoiceList } from "@oxagen/oxagen/contracts/billing.invoice.list";
import { billingSubscriptionRead } from "@oxagen/oxagen/contracts/billing.subscription.read";
import { captureError } from "@oxagen/telemetry";
import { cache } from "react";
import type { z } from "zod";
import {
  ContractRate,
  GauBucket,
  InvoicePage,
  PlanCard,
  UsageCredits,
} from "@/data/contracts/billing";
import type { DataSource } from "@/data/ports";
import { type Read, readError, readOk } from "@/data/read";
import { kernelRead } from "@/server/kernel";
import type { OrgCtx } from "@/server/viewer";
import {
  toContractRate,
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

/**
 * get_subscription, read once per render pass.
 *
 * Two of the page's five reads are mapped from this one record — the plan card
 * and the usage credit balance (§3.9's two meters are billed apart but read
 * together) — and the handler aggregates token usage over ClickHouse on every
 * invocation. `cache` is keyed on the argument, and billing.tsx hands both
 * reads the same `ctx`, so the page pays for the aggregation once. A caller
 * outside that pass simply reads again, which is correct, only not shared.
 */
const readSubscription = cache((ctx: OrgCtx) =>
  kernelRead(ctx, {
    contract: billingSubscriptionRead,
    input: {},
    page: "billing",
  }),
);

export const billing: DataSource["billing"] = {
  async plan(ctx) {
    const read = await readSubscription(ctx);
    return read.ok
      ? parsed(PlanCard, toPlanCard(read.value), ctx.orgId, "plan")
      : read;
  },
  async usageCredits(ctx) {
    const read = await readSubscription(ctx);
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

import { bigint, boolean, index, integer, jsonb, numeric, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { billingSchema } from "./_schemas.js";
import { auditMixin, citext, idMixin, softDeleteMixin } from "./_mixins.js";

export const plans = billingSchema.table(
  "plans",
  {
    ...idMixin("pln"),
    ...auditMixin(),
    name: text("name").notNull(),
    slug: citext("slug").notNull(),
    tier: text("tier").notNull(),
    stripeProductId: text("stripe_product_id").notNull(),
    stripePriceIdMonthly: text("stripe_price_id_monthly"),
    stripePriceIdAnnual: text("stripe_price_id_annual"),
    monthlyCents: integer("monthly_cents").notNull(),
    annualCents: integer("annual_cents"),
    includedCreditCents: integer("included_credit_cents").notNull().default(0),
    includedSeats: integer("included_seats").notNull().default(1),
    features: jsonb("features").notNull().default(sql`'{}'::jsonb`),
    isPublic: boolean("is_public").notNull().default(true),
  },
  (t) => ({
    slugIdx: uniqueIndex("plans_slug_idx").on(t.slug),
  }),
);

export const subscriptions = billingSchema.table(
  "subscriptions",
  {
    ...idMixin("sub"),
    ...auditMixin(),
    orgId: uuid("org_id").notNull(),
    planId: uuid("plan_id").notNull(),
    stripeSubscriptionId: text("stripe_subscription_id").notNull(),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    status: text("status").notNull(),
    billingInterval: text("billing_interval").notNull(),
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true, mode: "date" }).notNull(),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true, mode: "date" }).notNull(),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    canceledAt: timestamp("canceled_at", { withTimezone: true, mode: "date" }),
    trialEnd: timestamp("trial_end", { withTimezone: true, mode: "date" }),
    seatCount: integer("seat_count").notNull().default(1),
  },
  (t) => ({
    stripeSubIdx: uniqueIndex("subscriptions_stripe_sub_idx").on(t.stripeSubscriptionId),
    // Spec §6.13: index targets the "active subscription for tenant" hot path
    // — composite over (org_id, status) avoids a tenant-id-only scan.
    tenantStatusIdx: index("subscriptions_org_status_idx").on(t.orgId, t.status),
  }),
);

export const paymentMethods = billingSchema.table(
  "payment_methods",
  {
    ...idMixin("pm"),
    ...auditMixin(),
    ...softDeleteMixin(),
    orgId: uuid("org_id").notNull(),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    stripePaymentMethodId: text("stripe_payment_method_id").notNull(),
    type: text("type").notNull(),
    brand: text("brand"),
    last4: text("last4"),
    expMonth: integer("exp_month"),
    expYear: integer("exp_year"),
    isDefault: boolean("is_default").notNull().default(false),
  },
  (t) => ({
    stripePmIdx: uniqueIndex("payment_methods_stripe_pm_idx").on(t.stripePaymentMethodId),
    orgIdx: index("payment_methods_org_idx").on(t.orgId),
  }),
);

export const invoices = billingSchema.table(
  "invoices",
  {
    ...idMixin("inv"),
    ...auditMixin(),
    orgId: uuid("org_id").notNull(),
    subscriptionId: uuid("subscription_id"),
    stripeInvoiceId: text("stripe_invoice_id").notNull(),
    number: text("number"),
    status: text("status").notNull(),
    amountDueCents: integer("amount_due_cents").notNull(),
    amountPaidCents: integer("amount_paid_cents").notNull().default(0),
    amountRemainingCents: integer("amount_remaining_cents").notNull(),
    currency: text("currency").notNull().default("usd"),
    periodStart: timestamp("period_start", { withTimezone: true, mode: "date" }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true, mode: "date" }).notNull(),
    dueAt: timestamp("due_at", { withTimezone: true, mode: "date" }),
    paidAt: timestamp("paid_at", { withTimezone: true, mode: "date" }),
    hostedInvoiceUrl: text("hosted_invoice_url"),
    invoicePdfUrl: text("invoice_pdf_url"),
  },
  (t) => ({
    stripeInvIdx: uniqueIndex("invoices_stripe_inv_idx").on(t.stripeInvoiceId),
    orgIdx: index("invoices_org_idx").on(t.orgId, t.status),
  }),
);

export const invoiceLineItems = billingSchema.table(
  "invoice_line_items",
  {
    ...idMixin("ili"),
    invoiceId: uuid("invoice_id").notNull(),
    description: text("description").notNull(),
    quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull(),
    unitAmountCents: integer("unit_amount_cents").notNull(),
    totalCents: integer("total_cents").notNull(),
    metric: text("metric"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => ({
    invoiceIdx: index("invoice_line_items_invoice_idx").on(t.invoiceId),
  }),
);

export const usageRecords = billingSchema.table(
  "usage_records",
  {
    ...idMixin("usg"),
    ...auditMixin(),
    orgId: uuid("org_id").notNull(),
    subscriptionId: uuid("subscription_id").notNull(),
    metric: text("metric").notNull(),
    quantity: numeric("quantity", { precision: 20, scale: 6 }).notNull(),
    unitCostMicros: bigint("unit_cost_micros", { mode: "bigint" }).notNull(),
    totalCostMicros: bigint("total_cost_micros", { mode: "bigint" }).notNull(),
    periodStart: timestamp("period_start", { withTimezone: true, mode: "date" }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true, mode: "date" }).notNull(),
    sourceQueryId: text("source_query_id"),
  },
  (t) => ({
    uniqIdx: uniqueIndex("usage_records_sub_metric_period_idx").on(
      t.subscriptionId,
      t.metric,
      t.periodStart,
      t.periodEnd,
    ),
    orgIdx: index("usage_records_org_idx").on(t.orgId),
  }),
);

export const creditBalances = billingSchema.table(
  "credit_balances",
  {
    ...idMixin("cbl"),
    ...auditMixin(),
    orgId: uuid("org_id").notNull(),
    balanceCents: bigint("balance_cents", { mode: "bigint" }).notNull().default(0n),
    lastEventAt: timestamp("last_event_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    orgIdx: uniqueIndex("credit_balances_org_idx").on(t.orgId),
  }),
);

export const creditLedger = billingSchema.table(
  "credit_ledger",
  {
    ...idMixin("cld"),
    orgId: uuid("org_id").notNull(),
    deltaCents: bigint("delta_cents", { mode: "bigint" }).notNull(),
    reason: text("reason").notNull(),
    referenceType: text("reference_type"),
    referenceId: uuid("reference_id"),
    createdByUserId: uuid("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => ({
    organizationCreatedIdx: index("credit_ledger_org_created_idx").on(t.orgId, t.createdAt),
  }),
);

export const stripeEvents = billingSchema.table(
  "stripe_events",
  {
    ...idMixin("sev"),
    stripeEventId: text("stripe_event_id").notNull(),
    eventType: text("event_type").notNull(),
    apiVersion: text("api_version"),
    payload: jsonb("payload").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true, mode: "date" }),
    processingError: text("processing_error"),
  },
  (t) => ({
    // Idempotency: ON CONFLICT (stripe_event_id) DO NOTHING in the webhook
    // path collapses retries to a no-op.
    stripeEventIdx: uniqueIndex("stripe_events_stripe_event_idx").on(t.stripeEventId),
    typeIdx: index("stripe_events_type_idx").on(t.eventType),
  }),
);

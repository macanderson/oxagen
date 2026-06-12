import { bigint, boolean, check, index, integer, jsonb, numeric, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { billingSchema } from "./_schemas";
import { auditMixin, citext, idMixin, uuidv7Default } from "./_mixins";
import { organizations } from "./org";

// ── Append-only audit mixin (no updated_* columns) ──────────────────────────
// Used on immutable/append-only tables (usage_records, credit_ledger) where
// UPDATE is prohibited. Drizzle will not generate updated_* columns so a
// fresh `drizzle-kit generate` cannot produce an ALTER TABLE to add them.
const appendOnlyAuditMixin = () => ({
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
  createdByUserId: uuid("created_by_user_id"),
});

export const plans = billingSchema.table(
  "plans",
  {
    ...idMixin("pln"),
    ...auditMixin(),
    name: text("name").notNull(),
    slug: citext("slug").notNull(),
    // CHECK: tier IN ('free','build','scale','enterprise'). Build is self-serve;
    // Scale is growth; Enterprise is sales-led (ACLs/SSO/SCIM/audit live here).
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
    tierCheck: check("plans_tier_check", sql`${t.tier} IN ('free','build','scale','enterprise')`),
  }),
);

export const subscriptions = billingSchema.table(
  "subscriptions",
  {
    ...idMixin("sub"),
    ...auditMixin(),
    // FK → org.organizations.id — declared here so drizzle-kit generates the
    // constraint and a fresh `generate` is a no-op against the real DDL.
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    // FK → billing.plans.id
    planId: uuid("plan_id")
      .notNull()
      .references(() => plans.id),
    stripeSubscriptionId: text("stripe_subscription_id").notNull(),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    status: text("status").notNull(),
    // CHECK: billing_interval IN ('month','year') — Stripe only emits these two
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
    // Spec §6.13: composite index over (org_id, status) targets the
    // "active subscription for org" hot path.
    orgStatusIdx: index("subscriptions_org_status_idx").on(t.orgId, t.status),
    billingIntervalCheck: check(
      "subscriptions_billing_interval_check",
      sql`${t.billingInterval} IN ('month','year')`,
    ),
    statusCheck: check("subscriptions_status_check", sql`${t.status} IN ('active', 'past_due', 'canceled', 'trialing', 'unpaid', 'incomplete', 'incomplete_expired', 'paused')`),
    // Partial unique: one 'active' subscription per org.
    // Allows multiple non-active subscriptions (past_due, canceled, etc.)
    // without blocking legitimate Stripe lifecycle events.
    activeSubscriptionIdx: uniqueIndex("subscriptions_org_active_idx")
      .on(t.orgId)
      .where(sql`${t.status} = 'active'`),
  }),
);

export const paymentMethods = billingSchema.table(
  "payment_methods",
  {
    ...idMixin("pm"),
    ...auditMixin(),
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }),
    deletedByUserId: uuid("deleted_by_user_id"),
    // FK → org.organizations.id
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
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
    // FK → org.organizations.id
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    // FK → billing.subscriptions.id (nullable — one-off invoices have no sub)
    subscriptionId: uuid("subscription_id").references(() => subscriptions.id),
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
    statusCheck: check("invoices_status_check", sql`${t.status} IN ('draft', 'open', 'paid', 'uncollectible', 'void')`),
  }),
);

// invoice_line_items is an append-only join/detail table. No public_id —
// the only lookup path is by invoice_id. Dropping public_id removes the
// superfluous unique index and .$defaultFn() overhead on every insert.
export const invoiceLineItems = billingSchema.table(
  "invoice_line_items",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    // FK → org.organizations.id — denormalized for tenant isolation.
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    // FK → billing.invoices.id
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    description: text("description").notNull(),
    quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull(),
    unitAmountCents: integer("unit_amount_cents").notNull(),
    totalCents: integer("total_cents").notNull(),
    metric: text("metric"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => ({
    invoiceIdx: index("invoice_line_items_invoice_idx").on(t.invoiceId),
    orgIdx: index("invoice_line_items_org_idx").on(t.orgId),
  }),
);

// usage_records is append-only: metered consumption events written once by the
// billing engine. Dropping updated_at / updated_by_user_id enforces immutability
// at the schema level — Drizzle will never generate a SET updated_at = ... for
// this table.
export const usageRecords = billingSchema.table(
  "usage_records",
  {
    ...idMixin("usg"),
    ...appendOnlyAuditMixin(),
    // FK → org.organizations.id
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    // FK → billing.subscriptions.id
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => subscriptions.id),
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
    // FK → org.organizations.id
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    // CHECK: balance_cents >= 0 — hard floor at 0 (locked credit model: 1
    // credit = 1 cent, NO overdraft). Catches any code path that would write
    // a negative balance without going through grantCredits.
    // Note: default uses sql`0` not BigInt 0n to avoid a drizzle-kit
    // snapshot-serialization bug (BigInt in JSON.stringify) affecting
    // drizzle-kit ≤0.31. sql`0` is DB-level 0; the column type is bigint.
    balanceCents: bigint("balance_cents", { mode: "bigint" }).notNull().default(sql`0`),
    lastEventAt: timestamp("last_event_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    orgIdx: uniqueIndex("credit_balances_org_idx").on(t.orgId),
    balanceNonNegativeCheck: check(
      "credit_balances_balance_non_negative",
      sql`${t.balanceCents} >= 0`,
    ),
  }),
);

// credit_ledger is the immutable audit trail for all balance mutations.
// No public_id (internal-only, no API surface). No updated_* columns
// (append-only invariant: rows are never modified after insert).
export const creditLedger = billingSchema.table(
  "credit_ledger",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    // FK → org.organizations.id
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    // CHECK: delta_cents <> 0 — a zero-delta entry is a logic error; it
    // pollutes the audit trail without changing the balance.
    deltaCents: bigint("delta_cents", { mode: "bigint" }).notNull(),
    reason: text("reason").notNull(),
    referenceType: text("reference_type"),
    referenceId: uuid("reference_id"),
    createdByUserId: uuid("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => ({
    organizationCreatedIdx: index("credit_ledger_org_created_idx").on(t.orgId, t.createdAt),
    deltaNonZeroCheck: check(
      "credit_ledger_delta_non_zero",
      sql`${t.deltaCents} <> 0`,
    ),
    // Atomic grant idempotency (OXA-1509). grants.ts inserts with
    // INSERT … ON CONFLICT DO NOTHING; this partial unique index is the
    // arbiter. Partial because only grant rows carry (reference_type,
    // reference_id) — spend/usage rows leave them NULL and must stay
    // unconstrained (multiple NULLs would otherwise collide).
    grantIdempotencyIdx: uniqueIndex("credit_ledger_grant_idempotency_idx")
      .on(t.orgId, t.reason, t.referenceType, t.referenceId)
      .where(sql`${t.referenceType} IS NOT NULL AND ${t.referenceId} IS NOT NULL`),
  }),
);

// credit_lots: the authoritative source of truth for credit holdings. Each
// grant creates a lot with a source, original_cents, remaining_cents, and
// an optional expires_at. Consumption drains lots SOONEST-EXPIRING-FIRST
// (expires_at NULLS LAST). credit_balances remains a cached mirror for
// compatibility but lots are the source of truth.
export const creditLots = billingSchema.table(
  "credit_lots",
  {
    ...idMixin("clt"),
    ...auditMixin(),
    // FK → org.organizations.id
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    // CHECK: source IN ('free_grant','subscription','purchase')
    source: text("source").notNull(),
    // The original amount when the lot was granted.
    originalCents: bigint("original_cents", { mode: "bigint" }).notNull(),
    // Remaining balance for this lot. Decremented as credits are consumed.
    // CHECK: 0 <= remaining_cents <= original_cents
    remainingCents: bigint("remaining_cents", { mode: "bigint" }).notNull(),
    // When this lot was granted.
    grantedAt: timestamp("granted_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    // Nullable = this lot never expires. Otherwise: end-of-grant-month for
    // subscription allotments, granted_at + 1yr for purchase packs.
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    orgExpiryIdx: index("credit_lots_org_expiry_idx").on(t.orgId, t.expiresAt),
    sourceCheck: check(
      "credit_lots_source_check",
      sql`${t.source} IN ('free_grant','subscription','purchase')`,
    ),
    remainingNonNegativeCheck: check(
      "credit_lots_remaining_non_negative",
      sql`${t.remainingCents} >= 0`,
    ),
    remainingLeOriginalCheck: check(
      "credit_lots_remaining_le_original",
      sql`${t.remainingCents} <= ${t.originalCents}`,
    ),
  }),
);

// stripe_events: immutable raw-event store. Mutable processing state
// (processed_at, processing_error) was split into stripe_event_processing
// so this row is never UPDATEd after insert — the idempotency anchor is
// always a true INSERT. No public_id (internal audit table).
export const stripeEvents = billingSchema.table(
  "stripe_events",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    stripeEventId: text("stripe_event_id").notNull(),
    eventType: text("event_type").notNull(),
    apiVersion: text("api_version"),
    payload: jsonb("payload").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => ({
    // Idempotency: ON CONFLICT (stripe_event_id) DO NOTHING in the webhook
    // path collapses retries to a no-op.
    stripeEventIdx: uniqueIndex("stripe_events_stripe_event_idx").on(t.stripeEventId),
    typeIdx: index("stripe_events_type_idx").on(t.eventType),
  }),
);

// org_billing_profiles: mutable 1:1 companion to org.organizations. Isolates
// billing PII (email, postal address, Google Place ID) in the billing schema.
// Not addressed by humans via a URL slug, so no public_id — bare UUID PK only.
// Address region uses ISO 3166-2 subdivision code; country uses ISO 3166-1 α-2.
export const orgBillingProfiles = billingSchema.table(
  "org_billing_profiles",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    // FK → org.organizations.id — CASCADE so the profile disappears when the
    // org is deleted. Policy §0 mandates FKs where the invariant exists.
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    billingEmail: citext("billing_email"),
    addressLine1: text("address_line1"),
    addressLine2: text("address_line2"),
    addressCity: text("address_city"),
    // ISO 3166-2 subdivision code, e.g. 'CA' for California.
    addressRegion: text("address_region"),
    addressPostalCode: text("address_postal_code"),
    // ISO 3166-1 alpha-2, e.g. 'US'.
    addressCountry: text("address_country"),
    // Google Places place_id — allows re-fetching or re-validating the address.
    addressPlaceId: text("address_place_id"),
    ...auditMixin(),
  },
  (t) => ({
    // 1:1 uniqueness: one billing profile per org.
    orgIdx: uniqueIndex("org_billing_profiles_org_idx").on(t.orgId),
  }),
);

// org_billing_settings: mutable 1:1 companion to org.organizations holding
// billing AUTOMATION preferences and DUNNING state. Two concerns, one row
// (both are per-org, 1:1, and read together on the billing page):
//   • Auto-reload — when the effective credit balance dips below
//     auto_reload_threshold_cents, an off-session PaymentIntent buys
//     auto_reload_amount_cents worth of credits on the saved card.
//   • Dunning — the failed-payment recovery lifecycle. active → grace
//     (first failed charge, usage still allowed until grace_ends_at) →
//     suspended (grace elapsed, still unpaid; usage hard-gated).
// No public_id (internal, addressed only by org_id).
export const orgBillingSettings = billingSchema.table(
  "org_billing_settings",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    // FK → org.organizations.id — CASCADE so settings vanish with the org.
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),

    // ── Auto-reload ───────────────────────────────────────────────────────────
    autoReloadEnabled: boolean("auto_reload_enabled").notNull().default(false),
    // Trigger reload when effective balance falls below this (credit cents).
    autoReloadThresholdCents: bigint("auto_reload_threshold_cents", { mode: "bigint" })
      .notNull()
      .default(sql`500`),
    // Face-value credits to purchase on each reload (credit cents).
    autoReloadAmountCents: bigint("auto_reload_amount_cents", { mode: "bigint" })
      .notNull()
      .default(sql`2000`),
    // Saved card to charge off-session; NULL → the customer's default PM.
    autoReloadPaymentMethodId: text("auto_reload_payment_method_id"),
    lastAutoReloadAt: timestamp("last_auto_reload_at", { withTimezone: true, mode: "date" }),

    // ── Low-balance warning ─────────────────────────────────────────────────────
    // Surface a dismissible re-up banner when balance drops below this.
    lowBalanceThresholdCents: bigint("low_balance_threshold_cents", { mode: "bigint" })
      .notNull()
      .default(sql`500`),

    // ── Dunning (failed-payment recovery) ───────────────────────────────────────
    // CHECK: dunning_state IN ('active','grace','suspended').
    dunningState: text("dunning_state").notNull().default("active"),
    // First failed-charge timestamp; cleared on recovery.
    delinquentSince: timestamp("delinquent_since", { withTimezone: true, mode: "date" }),
    // Grace window end. While now() < grace_ends_at usage is still allowed.
    graceEndsAt: timestamp("grace_ends_at", { withTimezone: true, mode: "date" }),
    // Hard-suspension timestamp once grace elapses and the invoice is still open.
    suspendedAt: timestamp("suspended_at", { withTimezone: true, mode: "date" }),
    // Last time we emailed/notified the customer about the delinquency.
    lastDunningNotifiedAt: timestamp("last_dunning_notified_at", { withTimezone: true, mode: "date" }),
    ...auditMixin(),
  },
  (t) => ({
    orgIdx: uniqueIndex("org_billing_settings_org_idx").on(t.orgId),
    dunningStateCheck: check(
      "org_billing_settings_dunning_state_check",
      sql`${t.dunningState} IN ('active','grace','suspended')`,
    ),
  }),
);

// billing_disputes: chargebacks / disputes raised against our charges. One row
// per Stripe dispute (idempotent on stripe_dispute_id). When a dispute opens we
// claw back any credits funded by the disputed charge and record how much, so
// the credit ledger stays honest against money actually collected.
export const billingDisputes = billingSchema.table(
  "billing_disputes",
  {
    ...idMixin("dsp"),
    ...auditMixin(),
    // FK → org.organizations.id
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    stripeDisputeId: text("stripe_dispute_id").notNull(),
    stripeChargeId: text("stripe_charge_id"),
    paymentIntentId: text("payment_intent_id"),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull().default("usd"),
    reason: text("reason"),
    // Stripe dispute status: warning_needs_response, needs_response, under_review,
    // won, lost, etc. Passthrough string — no CHECK (Stripe owns the vocabulary).
    status: text("status").notNull(),
    // Credits reversed from the org's lots when the dispute was opened.
    clawedBackCents: bigint("clawed_back_cents", { mode: "bigint" }).notNull().default(sql`0`),
    resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    stripeDisputeIdx: uniqueIndex("billing_disputes_stripe_dispute_idx").on(t.stripeDisputeId),
    orgIdx: index("billing_disputes_org_idx").on(t.orgId, t.status),
  }),
);

// stripe_event_processing: mutable sibling of stripe_events. One row per
// event; written after the event is processed (or on failure). Keeping
// processing state here means stripe_events is never updated — SOC2
// append-only audit requirement.
export const stripeEventProcessing = billingSchema.table(
  "stripe_event_processing",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    // FK → billing.stripe_events.id
    stripeEventId: uuid("stripe_event_id")
      .notNull()
      .references(() => stripeEvents.id, { onDelete: "cascade" }),
    processedAt: timestamp("processed_at", { withTimezone: true, mode: "date" }),
    processingError: text("processing_error"),
  },
  (t) => ({
    eventIdx: uniqueIndex("stripe_event_processing_event_idx").on(t.stripeEventId),
  }),
);

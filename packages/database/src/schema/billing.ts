import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { billingSchema } from "./_schemas";
import { auditMixin, citext, idMixin, uuidv7Default } from "./_mixins";
import { organizations } from "./org";

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
    /**
     * ADR-052 §4.2: governed actions included in this plan per entitlement
     * year. Stored rather than implied — an absent allowance is
     * indistinguishable from an unlimited one, and enterprise's "negotiated"
     * figure has to live somewhere a query can read it. CHECK: >= 0.
     */
    includedActionsAnnual: bigint("included_actions_annual", {
      mode: "bigint",
    })
      .notNull()
      .default(sql`25000`),
    features: jsonb("features").notNull().default(sql`'{}'::jsonb`),
    isPublic: boolean("is_public").notNull().default(true),
  },
  (t) => ({
    slugIdx: uniqueIndex("plans_slug_idx").on(t.slug),
    tierCheck: check(
      "plans_tier_check",
      sql`${t.tier} IN ('free','build','scale','enterprise')`,
    ),
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
    currentPeriodStart: timestamp("current_period_start", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    currentPeriodEnd: timestamp("current_period_end", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    canceledAt: timestamp("canceled_at", { withTimezone: true, mode: "date" }),
    trialEnd: timestamp("trial_end", { withTimezone: true, mode: "date" }),
    seatCount: integer("seat_count").notNull().default(1),
  },
  (t) => ({
    stripeSubIdx: uniqueIndex("subscriptions_stripe_sub_idx").on(
      t.stripeSubscriptionId,
    ),
    // Spec §6.13: composite index over (org_id, status) targets the
    // "active subscription for org" hot path.
    orgStatusIdx: index("subscriptions_org_status_idx").on(t.orgId, t.status),
    // FK → billing.plans. Index the FK so plan mutations don't seq-scan
    // subscriptions, and so the subscriptions→plans join (tier.ts) has a
    // covering index on the join key.
    planIdx: index("subscriptions_plan_idx").on(t.planId),
    billingIntervalCheck: check(
      "subscriptions_billing_interval_check",
      sql`${t.billingInterval} IN ('month','year')`,
    ),
    statusCheck: check(
      "subscriptions_status_check",
      sql`${t.status} IN ('active', 'past_due', 'canceled', 'trialing', 'unpaid', 'incomplete', 'incomplete_expired', 'paused')`,
    ),
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
    stripePmIdx: uniqueIndex("payment_methods_stripe_pm_idx").on(
      t.stripePaymentMethodId,
    ),
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
    periodStart: timestamp("period_start", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    periodEnd: timestamp("period_end", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    dueAt: timestamp("due_at", { withTimezone: true, mode: "date" }),
    paidAt: timestamp("paid_at", { withTimezone: true, mode: "date" }),
    hostedInvoiceUrl: text("hosted_invoice_url"),
    invoicePdfUrl: text("invoice_pdf_url"),
  },
  (t) => ({
    stripeInvIdx: uniqueIndex("invoices_stripe_inv_idx").on(t.stripeInvoiceId),
    orgIdx: index("invoices_org_idx").on(t.orgId, t.status),
    // FK → billing.subscriptions. Index the FK so a subscription delete/update
    // doesn't seq-scan invoices to enforce the constraint.
    subscriptionIdx: index("invoices_subscription_idx").on(t.subscriptionId),
    // Invoices list (org page: WHERE org_id ORDER BY created_at DESC) — the
    // existing orgIdx above leads with (org_id, status), not created_at, so
    // it doesn't serve this sort (2026-07-11 audit §4.1 item 5).
    orgCreatedIdx: index("invoices_org_created_idx").on(t.orgId, t.createdAt),
    statusCheck: check(
      "invoices_status_check",
      sql`${t.status} IN ('draft', 'open', 'paid', 'uncollectible', 'void')`,
    ),
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
    balanceCents: bigint("balance_cents", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    lastEventAt: timestamp("last_event_at", {
      withTimezone: true,
      mode: "date",
    }),
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
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    organizationCreatedIdx: index("credit_ledger_org_created_idx").on(
      t.orgId,
      t.createdAt,
    ),
    deltaNonZeroCheck: check(
      "credit_ledger_delta_non_zero",
      sql`${t.deltaCents} <> 0`,
    ),
    // Atomic GRANT idempotency. grants.ts inserts with
    // INSERT … ON CONFLICT DO NOTHING; this partial unique index is the
    // arbiter — it is the ONLY ledger writer that relies on it (refunds use a
    // SELECT pre-check in disputes.ts; spends do a plain INSERT in credits.ts).
    //
    // Scoped to grant_* reasons ONLY. A grant is "exactly once per reference";
    // spend/usage rows are append-only and legitimately repeat a reference:
    // the metering path debits with (reason=consume_token_overage,
    // reference_type=token_usage, reference_id=messageId), and a single turn
    // makes MULTIPLE billable LLM calls (e.g. a tool that itself calls the AI
    // layer + the main chat stream) that all share one messageId. Without the
    // reason scope the second debit collides on this index → the charge throws
    // and the call goes unbilled (silent revenue leak). Keeping reference_id on
    // spend rows preserves message→debit traceability; the reason predicate is
    // what stops them from being uniquely constrained.
    grantIdempotencyIdx: uniqueIndex("credit_ledger_grant_idempotency_idx")
      .on(t.orgId, t.reason, t.referenceType, t.referenceId)
      .where(
        sql`${t.referenceType} IS NOT NULL AND ${t.referenceId} IS NOT NULL AND ${t.reason} LIKE 'grant_%'`,
      ),
    // Credit-ledger dispute/refund idempotency pre-checks (2026-07-11 audit
    // §4.1 item 9). Distinct from grantIdempotencyIdx above, which is scoped
    // to reason LIKE 'grant_%' only — disputes.ts's refund pre-check has no
    // covering index today.
    orgReasonRefIdx: index("credit_ledger_org_reason_ref_idx")
      .on(t.orgId, t.reason, t.referenceType, t.referenceId)
      .where(
        sql`${t.referenceType} IS NOT NULL AND ${t.referenceId} IS NOT NULL`,
      ),
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
    grantedAt: timestamp("granted_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
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
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // Idempotency: ON CONFLICT (stripe_event_id) DO NOTHING in the webhook
    // path collapses retries to a no-op.
    stripeEventIdx: uniqueIndex("stripe_events_stripe_event_idx").on(
      t.stripeEventId,
    ),
    typeIdx: index("stripe_events_type_idx").on(t.eventType),
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
    autoReloadThresholdCents: bigint("auto_reload_threshold_cents", {
      mode: "bigint",
    })
      .notNull()
      .default(sql`500`),
    // Face-value credits to purchase on each reload (credit cents).
    autoReloadAmountCents: bigint("auto_reload_amount_cents", {
      mode: "bigint",
    })
      .notNull()
      .default(sql`2000`),
    // Saved card to charge off-session; NULL → the customer's default PM.
    autoReloadPaymentMethodId: text("auto_reload_payment_method_id"),
    lastAutoReloadAt: timestamp("last_auto_reload_at", {
      withTimezone: true,
      mode: "date",
    }),
    // The Stripe idempotency key for the low-balance episode currently in
    // flight, or NULL when no reload is outstanding. Written BEFORE the card is
    // charged and cleared only once the credits are granted, so a retry of a
    // charged-but-ungranted reload sends Stripe the same key and is
    // de-duplicated no matter how much later it runs. It replaces a key derived
    // from the calendar hour, which a retry 40 seconds after the charge could
    // cross — charging the card twice for one top-up (#1420).
    autoReloadEpisodeKey: text("auto_reload_episode_key"),
    // When the open episode claimed its key. Stripe forgets an idempotency key
    // after 24 hours, after which the same key would charge again, so an
    // episode older than that stops retrying and alerts instead.
    autoReloadEpisodeStartedAt: timestamp("auto_reload_episode_started_at", {
      withTimezone: true,
      mode: "date",
    }),

    // ── Cost-meter carry ────────────────────────────────────────────────────────
    // Fractional credits owed but not yet debited, in MICRO-credits (1 credit =
    // 1,000,000 here). The ledger is whole credits, so a call worth 0.0014 of a
    // credit used to be rounded UP to one — charging a 200-token embedding 739x
    // its cost (#1413). The meter now banks the fraction here and debits a whole
    // credit only once the fractions add up to one, which is exact over a
    // sequence of calls and keeps the ledger integral. Always in [0, 1e6).
    meterCarryMicroCredits: bigint("meter_carry_micro_credits", {
      mode: "bigint",
    })
      .notNull()
      .default(sql`0`),

    // ── Low-balance warning ─────────────────────────────────────────────────────
    // Surface a dismissible re-up banner when balance drops below this.
    lowBalanceThresholdCents: bigint("low_balance_threshold_cents", {
      mode: "bigint",
    })
      .notNull()
      .default(sql`500`),
    // ADR-053 §3: monthly cap on assistant tokens the PLATFORM key pays for,
    // in credit cents. NULL is "no cap", an operator's choice and never the
    // default. Irrelevant to an organisation on its own key.
    assistantSpendCapCents: bigint("assistant_spend_cap_cents", {
      mode: "bigint",
    }).default(sql`2000`),
    /**
     * ADR-052 §4.3 / spec §7.4: bill for evidence retained beyond the included
     * twelve months. OPT-IN, and the default is the whole point — silently
     * accruing storage charges on evidence a customer forgot they were keeping
     * is the surprise this pricing model exists to avoid.
     */
    extendedEvidenceRetentionEnabled: boolean(
      "extended_evidence_retention_enabled",
    )
      .notNull()
      .default(false),

    // ── Dunning (failed-payment recovery) ───────────────────────────────────────
    // CHECK: dunning_state IN ('active','grace','suspended').
    dunningState: text("dunning_state").notNull().default("active"),
    // First failed-charge timestamp; cleared on recovery.
    delinquentSince: timestamp("delinquent_since", {
      withTimezone: true,
      mode: "date",
    }),
    // Grace window end. While now() < grace_ends_at usage is still allowed.
    graceEndsAt: timestamp("grace_ends_at", {
      withTimezone: true,
      mode: "date",
    }),
    // Hard-suspension timestamp once grace elapses and the invoice is still open.
    suspendedAt: timestamp("suspended_at", {
      withTimezone: true,
      mode: "date",
    }),
    // Last time we emailed/notified the customer about the delinquency.
    lastDunningNotifiedAt: timestamp("last_dunning_notified_at", {
      withTimezone: true,
      mode: "date",
    }),
    ...auditMixin(),
  },
  (t) => ({
    orgIdx: uniqueIndex("org_billing_settings_org_idx").on(t.orgId),
    dunningStateCheck: check(
      "org_billing_settings_dunning_state_check",
      sql`${t.dunningState} IN ('active','grace','suspended')`,
    ),
    // Only the lower bound. Between transactions the carry is under one credit,
    // but the statement that accumulates it writes the running total before the
    // same transaction reduces it to the remainder, so an upper bound here would
    // reject the meter's own write.
    meterCarryNonNegativeCheck: check(
      "org_billing_settings_meter_carry_non_negative",
      sql`${t.meterCarryMicroCredits} >= 0`,
    ),
    // Ops reconciliation: which orgs are charged but not granted right now.
    openReloadEpisodeIdx: index("org_billing_settings_open_reload_episode_idx")
      .on(t.autoReloadEpisodeStartedAt)
      .where(sql`${t.autoReloadEpisodeKey} IS NOT NULL`),
  }),
);

// billing_disputes: chargebacks / disputes raised against our charges. One row
// per Stripe dispute (idempotent on stripe_dispute_id). When a dispute opens we
// claw back any credits funded by the disputed charge and record how much, so
// the credit ledger matches money actually collected.
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
    clawedBackCents: bigint("clawed_back_cents", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    stripeDisputeIdx: uniqueIndex("billing_disputes_stripe_dispute_idx").on(
      t.stripeDisputeId,
    ),
    orgIdx: index("billing_disputes_org_idx").on(t.orgId, t.status),
    // Dispute webhook resolution currently seq-scans on these two lookup
    // columns (2026-07-11 audit §4.1 item 4).
    paymentIntentIdx: index("billing_disputes_payment_intent_idx")
      .on(t.paymentIntentId)
      .where(sql`${t.paymentIntentId} IS NOT NULL`),
    stripeChargeIdx: index("billing_disputes_stripe_charge_idx")
      .on(t.stripeChargeId)
      .where(sql`${t.stripeChargeId} IS NOT NULL`),
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
    processedAt: timestamp("processed_at", {
      withTimezone: true,
      mode: "date",
    }),
    processingError: text("processing_error"),
  },
  (t) => ({
    eventIdx: uniqueIndex("stripe_event_processing_event_idx").on(
      t.stripeEventId,
    ),
  }),
);

// Hard PERIOD-TO-DATE spend ceiling. Distinct axis from the per-TURN
// dollar budget in workspace.workspace_budget_policy / budget.policy.* (which
// caps a single agent turn's cost): THIS ceiling
// caps cumulative period spend for a whole org or workspace and is enforced in
// the kernel's invoke() admission path (the budget gate, next to IAM/billing) so
// a runaway fleet is DENIED before the provider call, not discovered on the
// invoice.
//
// ONE table holds both scopes (mirrors workspace.routing_policy): a row with
// workspace_id = NULL is the ORG-LEVEL ceiling for all workspace spend; a
// non-NULL workspace_id scopes the ceiling to that one workspace. Both apply —
// the gate denies when EITHER is exceeded. RLS class `workspace_nullable` so a
// withTenantDb read sees the org-default row AND the workspace's own row.
export const spendBudgets = billingSchema.table(
  "spend_budgets",
  {
    ...idMixin("bdg"),
    ...auditMixin(),
    orgId: uuid("org_id").notNull(),
    // NULL ⇒ ORG-LEVEL ceiling covering every workspace; non-NULL ⇒ that one
    // workspace's ceiling.
    workspaceId: uuid("workspace_id"),
    // Whether this ceiling is enforced. A disabled row is a documented no-op.
    enabled: boolean("enabled").notNull().default(true),
    // Window the ceiling is measured over: "monthly" = calendar month to date
    // (UTC); "rolling" = the trailing `window_days`-day window ending now.
    period: text("period").notNull().default("monthly"),
    // Trailing window length in days for period = 'rolling'. NULL for 'monthly'.
    windowDays: integer("window_days"),
    // The hard ceiling in micro-USD (1 USD = 1_000_000), consistent with
    // token_usage.cost_usd_micros — integer math, no float rounding on a dollar
    // ceiling. bigint: a large enterprise monthly ceiling can exceed 2^31 micros
    // ($2.1k) easily.
    limitMicros: bigint("limit_micros", { mode: "bigint" }).notNull(),
    // Highest soft threshold (50/80/95/100) already notified for the CURRENT
    // period, so a crossing notifies at most once. Reset to 0 when
    // notified_period_start no longer equals the active period's start.
    notifiedThreshold: integer("notified_threshold").notNull().default(0),
    // The period-start the notified_threshold watermark belongs to; a mismatch
    // with the active period's start means the period rolled over → reset.
    notifiedPeriodStart: timestamp("notified_period_start", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (t) => ({
    // At most one org-level ceiling per org (workspace_id IS NULL)…
    orgDefaultIdx: uniqueIndex("spend_budgets_org_default_idx")
      .on(t.orgId)
      .where(sql`workspace_id IS NULL`),
    // …and at most one ceiling per workspace.
    workspaceIdx: uniqueIndex("spend_budgets_workspace_idx")
      .on(t.workspaceId)
      .where(sql`workspace_id IS NOT NULL`),
    orgWorkspaceIdx: index("spend_budgets_org_workspace_idx").on(
      t.orgId,
      t.workspaceId,
    ),
    periodCheck: check(
      "spend_budgets_period_check",
      sql`${t.period} IN ('monthly','rolling')`,
    ),
    // A rolling budget must carry a positive window; a monthly one must not.
    windowCheck: check(
      "spend_budgets_window_check",
      sql`(${t.period} = 'rolling' AND ${t.windowDays} IS NOT NULL AND ${t.windowDays} > 0) OR (${t.period} = 'monthly' AND ${t.windowDays} IS NULL)`,
    ),
    limitCheck: check("spend_budgets_limit_check", sql`${t.limitMicros} > 0`),
  }),
);

// ── governed_action_counters ─────────────────────────────────────────────────
//
// ADR-052: the running count of governed actions an organisation has taken in
// its current entitlement year, and how many of those were charged as overage.
//
// This is transactional state, not analytics, and the distinction is load
// bearing. Deciding whether THIS action falls inside the allowance needs the
// count INCLUDING this action, atomically. The recorder does one
// INSERT … ON CONFLICT DO UPDATE … RETURNING, which takes the row lock and
// answers in a single round trip on the invoke() hot path. The equivalent
// ClickHouse read would be eventually consistent and a second query per
// action; the per-capability breakdown stays there, where append-only
// analytics belongs.
//
// `actionsUsed` counts free actions too. Without that an organisation could
// not see how close it is to its allowance, because the ledger only records
// what it was charged for.
export const governedActionCounters = billingSchema.table(
  "governed_action_counters",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    // FK → org.organizations.id — CASCADE so the counter vanishes with the org.
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** First instant of the entitlement year this row counts, UTC. */
    periodStart: timestamp("period_start", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    /** Governed actions taken in the period, allowance-covered ones included. */
    actionsUsed: bigint("actions_used", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    /** Of those, the ones charged as overage past the allowance. */
    actionsCharged: bigint("actions_charged", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // The ON CONFLICT arbiter for the recorder's upsert, and the only read
    // path, so one index covers both.
    orgPeriodIdx: uniqueIndex("governed_action_counters_org_period_idx").on(
      t.orgId,
      t.periodStart,
    ),
    nonNegativeCheck: check(
      "governed_action_counters_used_non_negative",
      sql`${t.actionsUsed} >= 0 AND ${t.actionsCharged} >= 0`,
    ),
    chargedWithinUsedCheck: check(
      "governed_action_counters_charged_within_used",
      sql`${t.actionsCharged} <= ${t.actionsUsed}`,
    ),
  }),
);

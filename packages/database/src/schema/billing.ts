import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  date,
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
import {
  auditMixin,
  citext,
  idMixin,
  softDeleteMixin,
  uuidv7Default,
} from "./_mixins";
import { organizations } from "./org";

/**
 * ADR-055 §2: the four figures that price governed action units. Shared by
 * billing.plans (published terms) and billing.contract_terms (negotiated
 * terms) so both tables carry the same columns and the same CHECK.
 *
 * `rate_per_gau_micros` is micro-dollars (1 cent = 10,000 micros) so a
 * sub-cent rate is exact. `(rate_per_gau_micros * block_size_gau) % 10000 = 0`
 * makes a block price to whole cents, so no Checkout line needs rounding.
 */
const gauTermsColumns = () => ({
  currency: text("currency").notNull().default("usd"),
  ratePerGauMicros: bigint("rate_per_gau_micros", { mode: "bigint" }).notNull(),
  // > 0: a zero block size leaves the block price and the purchase step
  // undefined (quantityGau % blockSizeGau).
  blockSizeGau: integer("block_size_gau").notNull(),
  includedGauPerMonth: integer("included_gau_per_month").notNull(),
});

const gauTermsCheck = (t: {
  ratePerGauMicros: AnyPgColumn;
  blockSizeGau: AnyPgColumn;
  includedGauPerMonth: AnyPgColumn;
}) =>
  sql`${t.ratePerGauMicros} >= 0 AND ${t.blockSizeGau} > 0 AND ${t.includedGauPerMonth} >= 0 AND (${t.ratePerGauMicros} * ${t.blockSizeGau}) % 10000 = 0`;

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
    // ADR-055 §2: the published GAU terms of the tier. seed.ts writes them for
    // Free; pricing.ts writes them for the paid plans through
    // `pnpm billing:stripe-sync`. resolveContractTerms reads them live for an
    // org with no negotiated billing.contract_terms row, so nothing copies
    // them into the org and a plan change shows on the next read.
    ...gauTermsColumns(),
    features: jsonb("features").notNull().default(sql`'{}'::jsonb`),
    isPublic: boolean("is_public").notNull().default(true),
  },
  (t) => ({
    slugIdx: uniqueIndex("plans_slug_idx").on(t.slug),
    tierCheck: check(
      "plans_tier_check",
      sql`${t.tier} IN ('free','build','scale','enterprise')`,
    ),
    gauTermsCheck: check("plans_gau_terms_check", gauTermsCheck(t)),
  }),
);

// ADR-055 §2: a negotiated agreement, one row per organization with at most
// one effective (effective_to IS NULL) at a time. Written by an operator
// migration or a later set_contract_terms capability; never by the app or by
// create_org. The source is implied by the table, the tier is the
// entitlement's, the checkout uses price_data and what happens past the
// allowance is the org's billing mode on org_billing_settings, so there is no
// source, tier, stripe_price_id, exhaustion_policy or retention column.
// No public_id (internal, addressed only by org_id).
export const contractTerms = billingSchema.table(
  "contract_terms",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    // FK → org.organizations.id. No cascade: a commercial agreement holds its
    // organization in place, the way invoices and the credit ledger do.
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    agreementRef: text("agreement_ref").notNull(),
    ...gauTermsColumns(),
    effectiveFrom: timestamp("effective_from", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    effectiveTo: timestamp("effective_to", {
      withTimezone: true,
      mode: "date",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // One effective agreement per organization; resolveContractTerms reads
    // the row WHERE effective_to IS NULL.
    orgEffectiveIdx: uniqueIndex("contract_terms_org_effective_idx")
      .on(t.orgId)
      .where(sql`${t.effectiveTo} IS NULL`),
    gauTermsCheck: check("contract_terms_gau_terms_check", gauTermsCheck(t)),
    effectiveRangeCheck: check(
      "contract_terms_effective_range_check",
      sql`${t.effectiveTo} IS NULL OR ${t.effectiveTo} > ${t.effectiveFrom}`,
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
    /**
     * WHICH provider price this subscription is billed on. An identity, never
     * an amount: it recognises a subscription already sitting on the price a
     * caller is asking to move it to, which makes a retried plan change the
     * no-op it should be.
     *
     * Deliberately not accompanied by a stored price. Every figure that stood
     * in for "what this subscriber pays" has inverted — the tier rank, the
     * catalogue row, and `price.unit_amount` against a discount — so the
     * proration direction is measured by previewing the invoice instead
     * (#3157). A column here would only look like an answer.
     *
     * Nullable: written by `syncSubscriptionFromStripe`, so a row predating
     * that sync carries none.
     */
    stripePriceId: text("stripe_price_id"),
    /**
     * The plan a plan change is moving this subscription AWAY from, written
     * before the provider is asked to swap the price and cleared once the
     * prorated upgrade grant for that move has landed.
     *
     * Durable intent, and the only durable record of it. The grant's size is
     * `toPlan.includedCreditCents - fromPlan.includedCreditCents`, so it needs
     * the plan moved from — but `syncSubscriptionFromStripe` repoints
     * `plan_id` at the target as part of the swap. A call that died between
     * the swap and the grant therefore left a customer upgraded and
     * uncredited, with nothing left in the row to recompute the grant from
     * (#3157, PR #3171 review). This column is what the retry reads.
     *
     * Deliberately NOT in the `onConflictDoUpdate` set of
     * `syncSubscriptionFromStripe`: a provider sync must not erase an intent
     * the swap it is reporting has not finished acting on.
     *
     * Nullable, and null is the steady state — a subscription with no plan
     * change in flight carries none.
     */
    pendingUpgradeFromPlanId: uuid("pending_upgrade_from_plan_id").references(
      () => plans.id,
    ),
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
    ...softDeleteMixin(),
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
    createdById: uuid("created_by_id"),
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

    // ── Cost-meter carry, per billing reason ────────────────────────────────────
    // Fractional credits owed but not yet debited, in MICRO-credits (1 credit =
    // 1,000,000 here), keyed by the `credit_ledger.reason` that accrued them.
    // The ledger is whole credits, so a call worth 0.0014 of a credit used to be
    // rounded UP to one — charging a 200-token embedding 739x its cost (#1413).
    // The meter banks the fraction here and debits a whole credit only once the
    // fractions add up to one, which is exact over a sequence of calls and keeps
    // the ledger integral.
    //
    // The map replaced a single pooled bigint, which was exact in total but wrong
    // in attribution: fractions from every reason shared one counter, so whoever
    // crossed the whole-credit boundary was billed for the others. With
    // `consume_assistant_tokens` marked up at exactly cost (ADR-053 §3, amended
    // 2026-09-18) and every other line carrying the solved blended markup, that
    // pooling moved embedding margin onto the at-cost assistant line and counted
    // it against the assistant spend cap. One bucket per reason makes a fraction
    // debitable only under the reason that accrued it.
    //
    // A value is the sub-credit remainder, in [0, 1e6), plus, for a reason
    // whose shortfall is kept (`consume_assistant_tokens`, ADR-158), the whole
    // credits the balance could not cover times 1e6. consumeCredits collects
    // that debt first on the reason's next charge, and settleOwedCredits
    // collects it from the next grant. consumeCredits refuses to write a value
    // past 2^53, so every value stays exact as a JSON number. Absent key ==
    // nothing carried.
    meterCarryMicroCreditsByReason: jsonb("meter_carry_micro_credits_by_reason")
      .$type<Record<string, number>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    // The pooled carry this map replaced. Nothing in this tree reads or writes
    // it: it is kept for the expand-and-contract rollout, because production
    // applies migrations by hand and deploys code separately, so code from
    // before the per-reason carry keeps writing this column until the last
    // node is replaced. Dropping it in the same migration that added the map
    // would leave one of the two deploy orders writing to a column that is not
    // there, and the AI callers swallow metering failures, so every
    // platform-funded call in that gap would run with no credit debit. The
    // contract migration folds whatever accrued here into the
    // `consume_embedding` bucket and drops the column and its CHECK; it runs
    // once no node writes here.
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

    // ── GAU billing mode (ADR-055 §5) ───────────────────────────────────────────
    // The org's Stripe customer id, written once by ensureStripeCustomer. The
    // authoritative id: the metadata search it replaces is eventually
    // consistent, so two quick purchases by a subscription-less org could each
    // create a customer.
    stripeCustomerId: text("stripe_customer_id"),
    // true → invoice billing (consumption is never capped; overage is invoiced
    // at period end or when invoice_gau_max accrues); false → prepaid. Set only
    // by a platform operator through set_org_billing_terms.
    approvedForInvoiceBilling: boolean("approved_for_invoice_billing")
      .notNull()
      .default(false),
    // Read only when approved_for_invoice_billing is true; stored and inert
    // otherwise. CHECK > 0.
    invoiceGauMax: integer("invoice_gau_max").notNull().default(100000),
    // Prepaid only: when the bucket reaches remaining ≤ 0 the recorder charges
    // the saved payment method for auto_topup_blocks blocks. Owner or Admin
    // through set_auto_topup. CHECK auto_topup_blocks > 0.
    autoTopupEnabled: boolean("auto_topup_enabled").notNull().default(true),
    autoTopupBlocks: integer("auto_topup_blocks").notNull().default(1),

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
    // An object, and no bucket below zero. Only the lower bound: the upper bound
    // is a consequence of how consumeCredits writes (it banks the remainder, not
    // the running total), not something the column can assert per statement.
    // `jsonb_path_exists` without a timezone-dependent predicate is immutable, so
    // it is legal in a CHECK.
    meterCarryByReasonNonNegativeCheck: check(
      "org_billing_settings_meter_carry_by_reason_non_negative",
      sql`jsonb_typeof(${t.meterCarryMicroCreditsByReason}) = 'object' AND NOT jsonb_path_exists(${t.meterCarryMicroCreditsByReason}, '$.* ? (@ < 0)')`,
    ),
    // Guards the retained pooled column for the code that still writes it
    // during the rollout. Leaves with that column in the contract migration.
    meterCarryNonNegativeCheck: check(
      "org_billing_settings_meter_carry_non_negative",
      sql`${t.meterCarryMicroCredits} >= 0`,
    ),
    stripeCustomerIdx: uniqueIndex(
      "org_billing_settings_stripe_customer_idx",
    ).on(t.stripeCustomerId),
    invoiceGauMaxCheck: check(
      "org_billing_settings_invoice_gau_max_positive",
      sql`${t.invoiceGauMax} > 0`,
    ),
    autoTopupBlocksCheck: check(
      "org_billing_settings_auto_topup_blocks_positive",
      sql`${t.autoTopupBlocks} > 0`,
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

// ── spend_counters ───────────────────────────────────────────────────────────
//
// The running spend counter the recorders keep for the spend-budget gate
// (spec §12.5, ADR-060 §5). One row per (org, workspace, UTC day) in micro-USD:
// every gateway-metered model call (`@oxagen/ai`) and every attested tacho
// llm_call adds its cost with one INSERT … ON CONFLICT DO UPDATE. The gate and
// the budget panel sum the rows over the ceiling's window in Postgres, so a
// ClickHouse stall neither zeroes a ceiling nor denies a call (#2820).
//
// workspace_id is NULL for a frame that carried no workspace (a gateway call
// outside a workspace scope); an org-level ceiling sums every row, a workspace
// ceiling the rows that name it.
export const spendCounters = billingSchema.table(
  "spend_counters",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id"),
    day: date("day", { mode: "string" }).notNull(),
    // `sql\`0\``: drizzle-kit export cannot serialize a BigInt literal default.
    spentMicros: bigint("spent_micros", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    scopeDayIdx: uniqueIndex("spend_counters_scope_day_idx").on(
      t.orgId,
      sql`coalesce(${t.workspaceId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      t.day,
    ),
    spentCheck: check("spend_counters_spent_check", sql`${t.spentMicros} >= 0`),
  }),
);

// ── gau_buckets ──────────────────────────────────────────────────────────────
//
// ADR-055 §4–5: one row per organization per month, the unit the recorder
// debits and the gate reads. periodFor (packages/billing/src/gau-bucket.ts)
// picks the month: the anniversary-day slice of an entitled subscription's
// cycle, or the UTC calendar month for an org with none.
//
// remaining = included + purchased + carried − used and may be negative: the
// gate checks remaining > 0 before the handler and the recorder debits after
// it, so concurrent governed actions can drive used_gau past the total. The
// stored figure is not clamped. On rollover
// carried_gau = min(prev.purchased + prev.carried, max(0, prev.remaining)):
// bought units survive a month boundary; included ones do not.
//
// The recorder's lazy create and debit are one
// INSERT … ON CONFLICT (org_id, period_start) DO UPDATE … RETURNING on the
// caller's executor, the statement shape governed_action_counters had; the
// unique index is that statement's arbiter. There is no terms_source or
// terms_ref column: terms are resolved live and every settlement records the
// rate it charged. No public_id (internal, addressed only by org_id).
export const gauBuckets = billingSchema.table(
  "gau_buckets",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    // FK → org.organizations.id — CASCADE so the bucket vanishes with the org.
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** First instant of the month this row covers, UTC. */
    periodStart: timestamp("period_start", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    /** First instant after the month this row covers, UTC. */
    periodEnd: timestamp("period_end", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    /** included_gau_per_month of the terms in force when the row was created. */
    includedGau: bigint("included_gau", { mode: "number" }).notNull(),
    /** Units bought this month: paid checkout and auto_topup settlements. */
    purchasedGau: bigint("purchased_gau", { mode: "number" })
      .notNull()
      .default(sql`0`),
    /** Units carried in from the previous month by the rollover formula. */
    carriedGau: bigint("carried_gau", { mode: "number" })
      .notNull()
      .default(sql`0`),
    /** Governed actions recorded this month. */
    usedGau: bigint("used_gau", { mode: "number" }).notNull().default(sql`0`),
    /** Invoice billing: overage already claimed by an interim or period-close settlement. */
    overageInvoicedGau: bigint("overage_invoiced_gau", { mode: "number" })
      .notNull()
      .default(sql`0`),
    /** Invoice billing: how many interim settlements this month has claimed. */
    interimSeq: integer("interim_seq").notNull().default(0),
    /** Prepaid: how many auto top-up episodes this month has claimed. */
    topupSeq: integer("topup_seq").notNull().default(0),
    /**
     * Prepaid: the one auto top-up episode allowed open at a time. Set by the
     * claim, cleared when that settlement is paid or a paid Checkout clears it.
     * Not an FK: the settlement row references this bucket, and a reference
     * back would make the pair impossible to delete with the org.
     */
    openTopupSettlementId: uuid("open_topup_settlement_id"),
    /** Set by the close job once the month has ended and its overage is claimed. */
    closedAt: timestamp("closed_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // The ON CONFLICT arbiter for the recorder's upsert and the only read path.
    orgPeriodIdx: uniqueIndex("gau_buckets_org_period_idx").on(
      t.orgId,
      t.periodStart,
    ),
    countsNonNegativeCheck: check(
      "gau_buckets_counts_non_negative",
      sql`${t.includedGau} >= 0 AND ${t.purchasedGau} >= 0 AND ${t.carriedGau} >= 0 AND ${t.usedGau} >= 0 AND ${t.overageInvoicedGau} >= 0 AND ${t.interimSeq} >= 0 AND ${t.topupSeq} >= 0`,
    ),
    overageWithinUsedCheck: check(
      "gau_buckets_overage_invoiced_within_used",
      sql`${t.overageInvoicedGau} <= ${t.usedGau}`,
    ),
    periodRangeCheck: check(
      "gau_buckets_period_range_check",
      sql`${t.periodEnd} > ${t.periodStart}`,
    ),
  }),
);

// ── gau_settlements ──────────────────────────────────────────────────────────
//
// ADR-055 §6: the one settlement ledger. Every block purchase, auto top-up,
// interim and period-close charge is a Stripe Invoice recorded here. `id` is
// also the Stripe idempotency key. `paid` is the only terminal state: the
// synchronous result, the first invoice.paid and Stripe's later retry converge
// on one grant through `UPDATE … WHERE status <> 'paid'`.
//
// The amount and the hosted URL are read from the billing.invoices mirror
// through stripe_invoice_id, the failure reason is the job's log line, and
// every reader reaches a settlement through its bucket, so there is no
// amount_cents, failure_reason or hosted_invoice_url column and no
// (org_id, created_at) index. No public_id (internal).
export const gauSettlements = billingSchema.table(
  "gau_settlements",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    // FK → org.organizations.id. No cascade: a settlement is a money record
    // and holds its organization in place, the way invoices do.
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    // FK → billing.gau_buckets.id. The bucket the settlement was claimed
    // against; a grant lands on the org's current bucket, which may be later.
    bucketId: uuid("bucket_id")
      .notNull()
      .references(() => gauBuckets.id),
    // CHECK: kind IN ('checkout','auto_topup','interim_invoice','period_close').
    kind: text("kind").notNull(),
    /**
     * Per bucket and kind: topup_seq for auto_topup, interim_seq for
     * interim_invoice, 0 for period_close, NULL for checkout (the session id
     * is that kind's key).
     */
    seq: integer("seq"),
    quantityGau: bigint("quantity_gau", { mode: "number" }).notNull(),
    /** The contracted rate this settlement charged, recorded at claim time. */
    ratePerGauMicros: bigint("rate_per_gau_micros", {
      mode: "bigint",
    }).notNull(),
    currency: text("currency").notNull(),
    // CHECK: status IN ('pending','open','paid','failed').
    status: text("status").notNull().default("pending"),
    /** checkout kind: the Checkout Session; the webhook grant's idempotency key. */
    stripeCheckoutSessionId: text("stripe_checkout_session_id"),
    /** The Stripe Invoice behind this settlement; NULL until invoices.create returns. */
    stripeInvoiceId: text("stripe_invoice_id"),
    /**
     * checkout kind: the PaymentIntent the session charged. Recorded at grant
     * time because it is the ONLY identifier a later `charge.refunded` or
     * `charge.dispute.created` carries that reaches back to this purchase: a
     * Stripe Dispute has its own (empty) metadata rather than the charge's, so
     * metadata propagation alone cannot resolve a disputed GAU purchase.
     * ADR-085.
     */
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    /**
     * What the Checkout Session actually charged, tax included.
     *
     * `quantity_gau * rate_per_gau_micros` reconstructs the SUBTOTAL, and a
     * refund's amount includes refunded tax — so prorating a partial refund
     * against the subtotal over-withdraws by exactly the tax rate. This is the
     * denominator that makes a partial reversal proportional to what was
     * actually paid back. NULL for a settlement recorded before this column
     * existed. ADR-085.
     */
    chargedCents: bigint("charged_cents", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    /** When the row reached paid. */
    settledAt: timestamp("settled_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    // One interim settlement per threshold crossing, one top-up per episode:
    // the database-level backstop for the claim statements' re-checked WHERE.
    bucketKindSeqIdx: uniqueIndex("gau_settlements_bucket_kind_seq_idx")
      .on(t.bucketId, t.kind, t.seq)
      .where(sql`${t.seq} IS NOT NULL`),
    // The webhook grant's idempotency key.
    checkoutSessionIdx: uniqueIndex("gau_settlements_checkout_session_idx")
      .on(t.stripeCheckoutSessionId)
      .where(sql`${t.stripeCheckoutSessionId} IS NOT NULL`),
    // The reversal's lookup key: one PaymentIntent charges one session, so a
    // refund or dispute naming a PaymentIntent names at most one settlement.
    paymentIntentIdx: uniqueIndex("gau_settlements_payment_intent_idx")
      .on(t.stripePaymentIntentId)
      .where(sql`${t.stripePaymentIntentId} IS NOT NULL`),
    // Every reader reaches a settlement through its bucket.
    bucketIdx: index("gau_settlements_bucket_idx").on(t.bucketId),
    kindCheck: check(
      "gau_settlements_kind_check",
      sql`${t.kind} IN ('checkout','auto_topup','interim_invoice','period_close')`,
    ),
    statusCheck: check(
      "gau_settlements_status_check",
      sql`${t.status} IN ('pending','open','paid','failed')`,
    ),
    // seq is NULL exactly for a checkout row.
    seqByKindCheck: check(
      "gau_settlements_seq_by_kind_check",
      sql`(${t.kind} = 'checkout') = (${t.seq} IS NULL)`,
    ),
    amountsCheck: check(
      "gau_settlements_amounts_check",
      sql`${t.quantityGau} > 0 AND ${t.ratePerGauMicros} >= 0 AND (${t.seq} IS NULL OR ${t.seq} >= 0)`,
    ),
    chargedCentsCheck: check(
      "gau_settlements_charged_cents_non_negative",
      sql`${t.chargedCents} IS NULL OR ${t.chargedCents} >= 0`,
    ),
  }),
);

// ── gau_reversals ────────────────────────────────────────────────────────────
//
// ADR-085: the record of a refunded or disputed GAU block purchase.
//
// `gau_settlements` records money taken; this records money given back and the
// units withdrawn for it. It is a separate table rather than a status on the
// settlement because a settlement can be reversed partially, because the
// figure that matters (how many units were actually recovered) is not the
// figure the settlement carries, and because `paid` is the settlement ledger's
// only terminal state by design.
//
// Three quantities, all recorded, because they differ whenever the customer
// spent what they bought before asking for the money back:
//   requested_gau   — units the money reversal is worth, pro-rata on a partial.
//   reversed_gau    — units actually removed from the org's live bucket.
//   unrecovered_gau — requested − reversed: units already consumed, or rolled
//                     past the balance the gate reads. Not recovered, not a
//                     receivable, and deliberately visible instead of lost in
//                     the arithmetic (billing.gau_buckets forbids a negative
//                     purchased_gau, so the shortfall cannot be carried there).
//
// No public_id (internal, reached through its settlement).
export const gauReversals = billingSchema.table(
  "gau_reversals",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    // FK → org.organizations.id. No cascade: a money record holds its
    // organization in place, as gau_settlements does.
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    /**
     * The purchase being reversed, or NULL while the reversal is *pending*:
     * the money came back before the purchase was recorded. Stripe does not
     * order webhook deliveries, and a checkout grant that failed once is
     * retried later, so a refund can genuinely arrive first. The grant
     * reconciles against any pending row before it hands out spendable units.
     */
    settlementId: uuid("settlement_id").references(() => gauSettlements.id),
    /** The bucket actually debited: the org's bucket for the period the
     * reversal was processed in, which is the only balance the gate reads —
     * not necessarily the bucket the grant landed on. NULL while pending. */
    bucketId: uuid("bucket_id").references(() => gauBuckets.id),
    /**
     * The PaymentIntent the reversed money moved on. Always known — it is what
     * a refund and a dispute both name, and it is how a pending reversal finds
     * its purchase later.
     */
    stripePaymentIntentId: text("stripe_payment_intent_id").notNull(),
    // CHECK: kind IN ('refund','dispute').
    kind: text("kind").notNull(),
    /** The Stripe object that caused it: `ch_…` for a refund, `dp_…` for a
     * dispute. Half of the idempotency key — Stripe redelivers webhooks. */
    providerEventId: text("provider_event_id").notNull(),
    /** Units the money reversal is worth (pro-rata for a partial refund). */
    requestedGau: bigint("requested_gau", { mode: "number" }).notNull(),
    /** Units actually removed from the bucket. */
    reversedGau: bigint("reversed_gau", { mode: "number" }).notNull(),
    /** requested − reversed: already spent, or rolled past the live balance. */
    unrecoveredGau: bigint("unrecovered_gau", { mode: "number" }).notNull(),
    /** The money given back, in cents, as the provider reported it. */
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    currency: text("currency").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // The idempotency key. A redelivered charge.refunded or
    // charge.dispute.created finds this row and withdraws nothing twice.
    // Keyed on the PaymentIntent rather than the settlement so it still holds
    // for a pending row; one PaymentIntent charges one session, so for a
    // reconciled row it is the same key by another name.
    paymentIntentEventIdx: uniqueIndex(
      "gau_reversals_payment_intent_event_idx",
    ).on(t.stripePaymentIntentId, t.providerEventId),
    // The reconciliation's lookup: pending reversals awaiting their purchase.
    pendingIdx: index("gau_reversals_pending_idx")
      .on(t.stripePaymentIntentId)
      .where(sql`${t.settlementId} IS NULL`),
    // Readers reach a reversal through its bucket, as they do a settlement.
    bucketIdx: index("gau_reversals_bucket_idx").on(t.bucketId),
    kindCheck: check(
      "gau_reversals_kind_check",
      sql`${t.kind} IN ('refund','dispute')`,
    ),
    // Pending or settled, never half of each: one reconciliation resolves both.
    pendingConsistencyCheck: check(
      "gau_reversals_pending_consistency_check",
      sql`(${t.settlementId} IS NULL) = (${t.bucketId} IS NULL)`,
    ),
    quantitiesCheck: check(
      "gau_reversals_quantities_check",
      sql`${t.requestedGau} >= 0 AND ${t.reversedGau} >= 0 AND ${t.unrecoveredGau} >= 0 AND ${t.reversedGau} + ${t.unrecoveredGau} = ${t.requestedGau} AND ${t.amountCents} >= 0`,
    ),
  }),
);

// ── gau_ledger ───────────────────────────────────────────────────────────────
//
// ADR-158: one row per billed governed action, written in the same
// transaction that adds its units to the month bucket's `used_gau`. The bucket
// is the balance the gate reads; this is the itemisation behind it, so a
// statement or an invoice line can be cited down to the agent, the operator
// and the tool call, and `SUM(units)` over a bucket's rows equals the units
// the ledger added to that bucket.
//
// `idempotency_key` is what makes a retried action bill once: the insert is
// `ON CONFLICT (org_id, idempotency_key) DO NOTHING`, and only the rows that
// actually inserted are debited. Keys are namespaced by source
// (`kernel:…`, `tacho:…`, `tool:…`), built in gau-ledger.ts.
//
// The attribution columns are recorded facts, not tenancy keys. The workspace
// is `attributed_workspace_id` rather than `workspace_id` on purpose: this is
// an org-wide money record, read whole for a statement, and a `workspace_id`
// column would make it a workspace-scoped RLS table that hides rows from the
// organisation's own billing reads.
//
// No updated_* columns: append-only. No public_id (reached through a
// statement, never addressed on its own).
export const gauLedger = billingSchema.table(
  "gau_ledger",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    // FK → org.organizations.id. No cascade: a money record holds its
    // organization in place, as gau_settlements does.
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    // FK → billing.gau_buckets.id: the month bucket these units were added to.
    bucketId: uuid("bucket_id")
      .notNull()
      .references(() => gauBuckets.id),
    idempotencyKey: text("idempotency_key").notNull(),
    // CHECK: source IN ('kernel','tacho','external_tool').
    //   kernel: a top-level kernel invoke() (ADR-052 §3.1)
    //   tacho: a tool call a wrapped harness made and Tacho allowed
    //   external_tool: an external MCP tool call Oxagen authorised
    source: text("source").notNull(),
    /** Canonical capability name, for a kernel action. */
    capability: text("capability"),
    /** The tool the agent called, for a tool-call action (`Bash`, `mcp__github__…`). */
    toolName: text("tool_name"),
    /** The MCP server behind the tool, when the tool is an MCP tool. */
    mcpServer: text("mcp_server"),
    /** api, mcp, app, agent, runner or tacho. */
    surface: text("surface"),
    /** claude-code, codex, cursor or stella, for a wrapped-harness tool call. */
    harness: text("harness"),
    attributedWorkspaceId: uuid("attributed_workspace_id"),
    /** Agent public id (agt_…) or the Tacho agent key. */
    agentId: text("agent_id"),
    /** The IAM principal that acted. */
    principalId: text("principal_id"),
    principalKind: text("principal_kind"),
    /** The human operator the action is attributed to. */
    operatorUserId: text("operator_user_id"),
    runId: text("run_id"),
    /** Tacho session uuid, for a wrapped-harness tool call. */
    sessionId: text("session_id"),
    /** The model's tool-call id, or the harness's tool-use id. */
    toolCallId: text("tool_call_id"),
    requestId: text("request_id"),
    units: integer("units").notNull(),
    /** When the action happened, as its source reported it. */
    occurredAt: timestamp("occurred_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    /**
     * When the units were added to the bucket. Statements select on this, so a
     * statement and the invoices for the same period count the same units: a
     * tool call recorded on the 1st for an event on the 31st debits the new
     * month's bucket, and appears on the new month's statement.
     */
    billedAt: timestamp("billed_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // The dedup arbiter.
    orgIdempotencyIdx: uniqueIndex("gau_ledger_org_idempotency_idx").on(
      t.orgId,
      t.idempotencyKey,
    ),
    // Statements: WHERE org_id AND billed_at in [from, to).
    orgBilledIdx: index("gau_ledger_org_billed_idx").on(t.orgId, t.billedAt),
    // Reconciliation against the bucket.
    bucketIdx: index("gau_ledger_bucket_idx").on(t.bucketId),
    sourceCheck: check(
      "gau_ledger_source_check",
      sql`${t.source} IN ('kernel','tacho','external_tool')`,
    ),
    unitsCheck: check("gau_ledger_units_positive", sql`${t.units} > 0`),
    // Every row names what was billed.
    subjectCheck: check(
      "gau_ledger_subject_check",
      sql`${t.capability} IS NOT NULL OR ${t.toolName} IS NOT NULL`,
    ),
  }),
);

// ── prepaid_orders ───────────────────────────────────────────────────────────
//
// ADR-158: an enterprise order paid in advance on a Stripe invoice. One order
// can carry up to three lines: the platform licence for a period, prepaid
// governed action units, and prepaid usage credits for the in-app assistant.
// A platform operator issues it (`create_prepaid_invoice`, platformOnly); the
// units and the credits are granted when the invoice is paid, or when it is
// issued for an order marked `grant_on = 'issue'`. `units_granted_at` and
// `credits_granted_at` are the grant's idempotency fence.
//
// No public_id (internal; the invoice number is the customer-facing reference).
export const prepaidOrders = billingSchema.table(
  "prepaid_orders",
  {
    id: uuid("id").primaryKey().default(uuidv7Default),
    // FK → org.organizations.id. No cascade: a money record.
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    /** The signed agreement this order is under, printed on the invoice. */
    agreementRef: text("agreement_ref"),
    /** The customer's purchase order number, printed on the invoice. */
    poNumber: text("po_number"),
    currency: text("currency").notNull().default("usd"),
    licenceCents: bigint("licence_cents", { mode: "number" })
      .notNull()
      .default(sql`0`),
    licencePeriodStart: timestamp("licence_period_start", {
      withTimezone: true,
      mode: "date",
    }),
    licencePeriodEnd: timestamp("licence_period_end", {
      withTimezone: true,
      mode: "date",
    }),
    gauQuantity: bigint("gau_quantity", { mode: "number" })
      .notNull()
      .default(sql`0`),
    /** The contracted rate the units are sold at, recorded at issue. */
    ratePerGauMicros: bigint("rate_per_gau_micros", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    creditCents: bigint("credit_cents", { mode: "number" })
      .notNull()
      .default(sql`0`),
    // CHECK: grant_on IN ('paid','issue').
    grantOn: text("grant_on").notNull().default("paid"),
    // CHECK: status IN ('draft','open','paid','void','uncollectible').
    status: text("status").notNull().default("draft"),
    daysUntilDue: integer("days_until_due").notNull().default(30),
    memo: text("memo"),
    stripeInvoiceId: text("stripe_invoice_id"),
    /** The bucket the prepaid units were added to. */
    grantedBucketId: uuid("granted_bucket_id").references(() => gauBuckets.id),
    unitsGrantedAt: timestamp("units_granted_at", {
      withTimezone: true,
      mode: "date",
    }),
    creditsGrantedAt: timestamp("credits_granted_at", {
      withTimezone: true,
      mode: "date",
    }),
    /** The operator run's request id (the platform-operator binding's requestId). */
    issuedByRequestId: text("issued_by_request_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    paidAt: timestamp("paid_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    stripeInvoiceIdx: uniqueIndex("prepaid_orders_stripe_invoice_idx")
      .on(t.stripeInvoiceId)
      .where(sql`${t.stripeInvoiceId} IS NOT NULL`),
    orgCreatedIdx: index("prepaid_orders_org_created_idx").on(
      t.orgId,
      t.createdAt,
    ),
    statusCheck: check(
      "prepaid_orders_status_check",
      sql`${t.status} IN ('draft','open','paid','void','uncollectible')`,
    ),
    grantOnCheck: check(
      "prepaid_orders_grant_on_check",
      sql`${t.grantOn} IN ('paid','issue')`,
    ),
    amountsCheck: check(
      "prepaid_orders_amounts_check",
      sql`${t.licenceCents} >= 0 AND ${t.gauQuantity} >= 0 AND ${t.ratePerGauMicros} >= 0 AND ${t.creditCents} >= 0 AND ${t.licenceCents} + ${t.gauQuantity} + ${t.creditCents} > 0 AND (${t.gauQuantity} * ${t.ratePerGauMicros}) % 10000 = 0 AND ${t.daysUntilDue} BETWEEN 0 AND 365`,
    ),
    // A licence line names its period; a period with no licence line is noise.
    licencePeriodCheck: check(
      "prepaid_orders_licence_period_check",
      sql`(${t.licencePeriodStart} IS NULL) = (${t.licencePeriodEnd} IS NULL) AND (${t.licencePeriodEnd} IS NULL OR ${t.licencePeriodEnd} > ${t.licencePeriodStart}) AND (${t.licenceCents} = 0 OR ${t.licencePeriodStart} IS NOT NULL)`,
    ),
  }),
);

/** Delivery and settlement state for one provider operation. Not an analytics store. */
export const usageOutbox = billingSchema.table(
  "usage_outbox",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    workspaceId: uuid("workspace_id").notNull(),
    usageComplete: boolean("usage_complete").notNull().default(false),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    charge: jsonb("charge").$type<Record<string, unknown>>(),
    admittedAt: timestamp("admitted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    incompleteIdx: index("usage_outbox_incomplete_idx")
      .on(t.admittedAt)
      .where(sql`${t.usageComplete} = false`),
    pendingIdx: index("usage_outbox_pending_idx")
      .on(t.nextAttemptAt)
      .where(sql`${t.deliveredAt} IS NULL AND ${t.payload} IS NOT NULL`),
  }),
);

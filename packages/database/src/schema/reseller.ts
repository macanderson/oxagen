import {
  check,
  index,
  integer,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { billingSchema } from "./_schemas";
import { auditMixin, bytea, idMixin, softDeleteMixin } from "./_mixins";
import { organizations } from "./org";

// Reseller Revenue — org-scoped tables in the `billing` schema backing the
// "Stripe for agents" re-bill loop. DDL source of truth is the hand-written
// migration 20260724120000_reseller_revenue.sql; this file mirrors it for query
// typing and relation inference. See docs/web-app-2.0/org/billing/revenue/spec.md.

/** Markup / per-unit price plans a reseller assigns to its customers. */
export const resellerPricePlans = billingSchema.table(
  "reseller_price_plans",
  {
    ...idMixin("resplan"),
    ...auditMixin(),
    ...softDeleteMixin(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    name: text("name").notNull(),
    // 'markup' | 'per_unit'
    pricingMode: text("pricing_mode").notNull(),
    markupBps: integer("markup_bps"),
    unitPriceCents: integer("unit_price_cents"),
    currency: text("currency").notNull().default("usd"),
  },
  (t) => ({
    orgIdx: index("reseller_price_plans_org_idx").on(t.orgId),
    modeCheck: check(
      "reseller_price_plans_pricing_mode_check",
      sql`${t.pricingMode} IN ('markup','per_unit')`,
    ),
    rateCheck: check(
      "reseller_price_plans_rate_check",
      sql`(${t.pricingMode} = 'markup' AND ${t.markupBps} IS NOT NULL) OR (${t.pricingMode} = 'per_unit' AND ${t.unitPriceCents} IS NOT NULL)`,
    ),
  }),
);

/** End-customer accounts a reseller bills, distinct from its own org membership. */
export const resellerCustomers = billingSchema.table(
  "reseller_customers",
  {
    ...idMixin("rescus"),
    ...auditMixin(),
    ...softDeleteMixin(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    name: text("name").notNull(),
    externalRef: text("external_ref"),
    stripeCustomerId: text("stripe_customer_id"),
    pricePlanId: uuid("price_plan_id").references(() => resellerPricePlans.id),
    // 'active' | 'paused'
    status: text("status").notNull().default("active"),
  },
  (t) => ({
    orgIdx: index("reseller_customers_org_idx").on(t.orgId),
    planIdx: index("reseller_customers_price_plan_idx").on(t.pricePlanId),
    statusCheck: check(
      "reseller_customers_status_check",
      sql`${t.status} IN ('active','paused')`,
    ),
  }),
);

/** Rules mapping a slice of observed usage (workspace/principal/capability) to a customer. */
export const resellerAttributionRules = billingSchema.table(
  "reseller_attribution_rules",
  {
    ...idMixin("resrule"),
    ...auditMixin(),
    ...softDeleteMixin(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    // 'workspace' | 'principal' | 'capability'
    matchKind: text("match_kind").notNull(),
    matchValue: text("match_value").notNull(),
    matchLabel: text("match_label").notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => resellerCustomers.id),
    priority: integer("priority").notNull().default(100),
  },
  (t) => ({
    orgPriorityIdx: index("reseller_attribution_rules_org_priority_idx").on(
      t.orgId,
      t.priority,
    ),
    customerIdx: index("reseller_attribution_rules_customer_idx").on(
      t.customerId,
    ),
    kindCheck: check(
      "reseller_attribution_rules_match_kind_check",
      sql`${t.matchKind} IN ('workspace','principal','capability')`,
    ),
  }),
);

/** One re-bill push per (customer, period) — idempotent; re-push updates in place. */
export const resellerRebillRuns = billingSchema.table(
  "reseller_rebill_runs",
  {
    ...idMixin("resrun"),
    ...auditMixin(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => resellerCustomers.id),
    periodStart: timestamp("period_start", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    periodEnd: timestamp("period_end", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    currency: text("currency").notNull().default("usd"),
    subtotalCents: integer("subtotal_cents").notNull().default(0),
    totalCents: integer("total_cents").notNull().default(0),
    providerInvoiceId: text("provider_invoice_id"),
    providerCustomerId: text("provider_customer_id"),
    hostedInvoiceUrl: text("hosted_invoice_url"),
    // 'pending' | 'pushed' | 'failed'
    status: text("status").notNull().default("pending"),
    error: text("error"),
  },
  (t) => ({
    orgCreatedIdx: index("reseller_rebill_runs_org_created_idx").on(
      t.orgId,
      t.createdAt,
    ),
    customerIdx: index("reseller_rebill_runs_customer_idx").on(t.customerId),
    statusCheck: check(
      "reseller_rebill_runs_status_check",
      sql`${t.status} IN ('pending','pushed','failed')`,
    ),
    periodUniq: uniqueIndex("reseller_rebill_runs_customer_period_uniq").on(
      t.orgId,
      t.customerId,
      t.periodStart,
      t.periodEnd,
    ),
  }),
);

/** Priced snapshot lines of a run — replaced wholesale on re-push (created_at only). */
export const resellerRebillLineItems = billingSchema.table(
  "reseller_rebill_line_items",
  {
    ...idMixin("resli"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    createdByUserId: uuid("created_by_user_id"),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    runId: uuid("run_id")
      .notNull()
      .references(() => resellerRebillRuns.id),
    label: text("label").notNull(),
    matchKind: text("match_kind"),
    matchValue: text("match_value"),
    rawCostCents: integer("raw_cost_cents").notNull().default(0),
    quantity: integer("quantity").notNull().default(0),
    unitPriceCents: integer("unit_price_cents"),
    amountCents: integer("amount_cents").notNull().default(0),
  },
  (t) => ({
    runIdx: index("reseller_rebill_line_items_run_idx").on(t.runId),
    orgIdx: index("reseller_rebill_line_items_org_idx").on(t.orgId),
    kindCheck: check(
      "reseller_rebill_line_items_match_kind_check",
      sql`${t.matchKind} IS NULL OR ${t.matchKind} IN ('workspace','principal','capability')`,
    ),
  }),
);

/** Per-org reseller Stripe key (envelope-encrypted at rest) — one row per org. */
export const resellerSettings = billingSchema.table(
  "reseller_settings",
  {
    ...idMixin("resset"),
    ...auditMixin(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    stripeSecretCiphertext: bytea("stripe_secret_ciphertext"),
    stripeSecretKeyId: text("stripe_secret_key_id"),
    stripeSecretLast4: text("stripe_secret_last4"),
    stripeAccountLabel: text("stripe_account_label"),
  },
  (t) => ({
    orgUniq: uniqueIndex("reseller_settings_org_unique").on(t.orgId),
  }),
);

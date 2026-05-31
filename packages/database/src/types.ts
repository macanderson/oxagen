/**
 * Precise row types inferred from the Drizzle schema.
 *
 * Use these instead of `schema as unknown as Record<string, any>` anywhere
 * we need to reference billing, chat, or other table rows in application code.
 * Re-exported from the `@oxagen/database` barrel so callers need only one import.
 */
import type { InferSelectModel } from "drizzle-orm";
import type {
  plans,
  subscriptions,
  invoices,
  creditBalances,
  creditLedger,
  usageRecords,
  conversations,
  messages,
  principals,
  roles,
  roleGrants,
  grants,
  policies,
  accessRequests,
  iamSessions,
} from "./schema/index.js";

// ── Billing row types ────────────────────────────────────────────────────────

/** Row type for `billing.plans`. */
export type PlanRow = InferSelectModel<typeof plans>;

/** Row type for `billing.subscriptions`. */
export type SubscriptionRow = InferSelectModel<typeof subscriptions>;

/** Row type for `billing.invoices`. */
export type InvoiceRow = InferSelectModel<typeof invoices>;

/** Row type for `billing.credit_balances`. */
export type CreditBalanceRow = InferSelectModel<typeof creditBalances>;

/** Row type for `billing.credit_ledger`. */
export type CreditLedgerRow = InferSelectModel<typeof creditLedger>;

/** Row type for `billing.usage_records`. */
export type UsageRecordRow = InferSelectModel<typeof usageRecords>;

/**
 * Convenience bundle of all billing tables exported from `@oxagen/database`.
 * Use this when you need typed access to the full billing portion of the schema.
 */
export type BillingTables = {
  plans: typeof plans;
  subscriptions: typeof subscriptions;
  invoices: typeof invoices;
  creditBalances: typeof creditBalances;
  creditLedger: typeof creditLedger;
  usageRecords: typeof usageRecords;
};

// ── Chat row types ───────────────────────────────────────────────────────────

/** Row type for `chat.conversations`. */
export type ConversationRow = InferSelectModel<typeof conversations>;

/** Row type for `chat.messages` — used by the active-branch walker. */
export type DbMessageRow = InferSelectModel<typeof messages>;

// ── IAM row types ────────────────────────────────────────────────────────────

/** Row type for `org.principals`. */
export type IamPrincipalRow = InferSelectModel<typeof principals>;

/** Row type for `org.roles`. */
export type IamRoleRow = InferSelectModel<typeof roles>;

/** Row type for `org.role_grants`. */
export type IamRoleGrantRow = InferSelectModel<typeof roleGrants>;

/** Row type for `org.grants`. */
export type IamGrantRow = InferSelectModel<typeof grants>;

/** Row type for `org.policies`. */
export type IamPolicyRow = InferSelectModel<typeof policies>;

/** Row type for `org.access_requests`. */
export type IamAccessRequestRow = InferSelectModel<typeof accessRequests>;

/** Row type for `org.iam_sessions`. */
export type IamSessionRow = InferSelectModel<typeof iamSessions>;

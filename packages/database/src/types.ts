/**
 * Precise row types inferred from the Drizzle schema.
 *
 * Use these instead of `schema as unknown as Record<string, any>` anywhere
 * we need to reference billing, chat, or other table rows in application code.
 * Re-exported from the `@oxagen/database` barrel so callers need only one import.
 */
import type { InferSelectModel, InferInsertModel } from "drizzle-orm";
import type {
  plans,
  subscriptions,
  invoices,
  creditBalances,
  creditLedger,
  conversations,
  messages,
  generatedAssets,
  principals,
  roles,
  roleGrants,
  principalRoleAssignments,
  accessRequests,
  userPreferences,
  workspaceUserPreferences,
  fontSizeEnum,
  densityEnum,
  pendingPromptBehaviorEnum,
  modelTierEnum,
  agentRuns,
  agentRunEvents,
  agentRunAttempts,
  agentRunAttemptLeases,
  agentRunCheckpoints,
  agentRunAttemptSeals,
  agentRunFinalizationGrants,
  agentRunFinalizationObligations,
} from "./schema/index";

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
};

// ── Chat row types ───────────────────────────────────────────────────────────

/** Row type for `chat.conversations`. */
export type ConversationRow = InferSelectModel<typeof conversations>;

/** Row type for `chat.messages` — used by the active-branch walker. */
export type DbMessageRow = InferSelectModel<typeof messages>;

// ── Content row types ──────────────────────────────────────────────────────────

/** Row type for `content.generated_assets` (AI-generated image/video assets). */
export type GeneratedAssetRow = InferSelectModel<typeof generatedAssets>;

// ── IAM row types ────────────────────────────────────────────────────────────

/** Row type for `org.principals`. */
export type IamPrincipalRow = InferSelectModel<typeof principals>;

/** Row type for `org.roles`. */
export type IamRoleRow = InferSelectModel<typeof roles>;

/** Row type for `org.role_grants`. */
export type IamRoleGrantRow = InferSelectModel<typeof roleGrants>;

/** Row type for `org.principal_role_assignments`. */
export type IamPrincipalRoleAssignmentRow = InferSelectModel<
  typeof principalRoleAssignments
>;

/** Row type for `org.access_requests`. */
export type IamAccessRequestRow = InferSelectModel<typeof accessRequests>;

// ── User preferences row types & enum unions ─────────────────────────────────
// These are the canonical shared vocabulary for the preferences feature.
// Import from `@oxagen/database` in API, MCP, and app layers.

/** Full SELECT row from `auth.user_preferences`. */
export type UserPreferences = InferSelectModel<typeof userPreferences>;

/** INSERT shape for `auth.user_preferences` (id/timestamps optional). */
export type NewUserPreferences = InferInsertModel<typeof userPreferences>;

/** Full SELECT row from `auth.workspace_user_preferences`. */
export type WorkspaceUserPreferences = InferSelectModel<
  typeof workspaceUserPreferences
>;

/** INSERT shape for `auth.workspace_user_preferences` (id/timestamps optional). */
export type NewWorkspaceUserPreferences = InferInsertModel<
  typeof workspaceUserPreferences
>;

/**
 * Closed set of font-size preference values.
 * Maps to the `auth.font_size` Postgres enum.
 */
export type FontSize = (typeof fontSizeEnum.enumValues)[number];

/**
 * Closed set of UI density preference values.
 * Maps to the `auth.density` Postgres enum.
 */
export type Density = (typeof densityEnum.enumValues)[number];

/**
 * Closed set of pending-prompt-behavior preference values.
 * Maps to the `auth.pending_prompt_behavior` Postgres enum.
 * queue = buffer new prompt; interrupt = cancel in-flight response.
 */
export type PendingPromptBehavior =
  (typeof pendingPromptBehaviorEnum.enumValues)[number];

/**
 * Closed set of Oxagen model-tier aliases (user & workspace level).
 * Maps to the `auth.model_tier` Postgres enum.
 * fast = lowest-latency, balanced = default, precise = best quality.
 */
export type ModelTier = (typeof modelTierEnum.enumValues)[number];

// ── Agent-engine v2 durable-run row types (Phase 2a) ─────────────────────────
// docs/specs/agent-engine-v2/plan.md Phase 2 — the run row + append-only
// event log that packages/agent-runner's executeTurn persists to.

/** Full SELECT row from `agent.agent_runs`. */
export type AgentRunRow = InferSelectModel<typeof agentRuns>;

/** INSERT shape for `agent.agent_runs` (id/timestamps/defaults optional). */
export type NewAgentRunRow = InferInsertModel<typeof agentRuns>;

/** Full SELECT row from `agent.agent_run_events` (append-only). */
export type AgentRunEventRow = InferSelectModel<typeof agentRunEvents>;

/** INSERT shape for `agent.agent_run_events` (id/created_at optional). */
export type NewAgentRunEventRow = InferInsertModel<typeof agentRunEvents>;

// ── Fenced attempt foundation row types ──────────────────────────────────────
// docs/specs/run-evidence-ingress — the immutable attempt identity, its mutable
// fenced lease, and the seal → grant → obligation chain every terminal outcome
// writes in one transaction.

/** Full SELECT row from `agent.agent_run_attempts` (immutable). */
export type AgentRunAttemptRow = InferSelectModel<typeof agentRunAttempts>;

/** INSERT shape for `agent.agent_run_attempts`. */
export type NewAgentRunAttemptRow = InferInsertModel<typeof agentRunAttempts>;

/**
 * Full SELECT row from `agent.agent_run_attempt_leases` — the one mutable row
 * in the foundation (renew/append/seal update it; DELETE stays revoked).
 */
export type AgentRunAttemptLeaseRow = InferSelectModel<
  typeof agentRunAttemptLeases
>;

/** INSERT shape for `agent.agent_run_attempt_leases`. */
export type NewAgentRunAttemptLeaseRow = InferInsertModel<
  typeof agentRunAttemptLeases
>;

/** Full SELECT row from `agent.agent_run_checkpoints` (immutable). */
export type AgentRunCheckpointRow = InferSelectModel<
  typeof agentRunCheckpoints
>;

/** INSERT shape for `agent.agent_run_checkpoints`. */
export type NewAgentRunCheckpointRow = InferInsertModel<
  typeof agentRunCheckpoints
>;

/** Full SELECT row from `agent.agent_run_attempt_seals` (immutable). */
export type AgentRunAttemptSealRow = InferSelectModel<
  typeof agentRunAttemptSeals
>;

/** INSERT shape for `agent.agent_run_attempt_seals`. */
export type NewAgentRunAttemptSealRow = InferInsertModel<
  typeof agentRunAttemptSeals
>;

/** Full SELECT row from `agent.agent_run_finalization_grants` (immutable). */
export type AgentRunFinalizationGrantRow = InferSelectModel<
  typeof agentRunFinalizationGrants
>;

/** INSERT shape for `agent.agent_run_finalization_grants`. */
export type NewAgentRunFinalizationGrantRow = InferInsertModel<
  typeof agentRunFinalizationGrants
>;

/** Full SELECT row from `agent.agent_run_finalization_obligations`. */
export type AgentRunFinalizationObligationRow = InferSelectModel<
  typeof agentRunFinalizationObligations
>;

/** INSERT shape for `agent.agent_run_finalization_obligations`. */
export type NewAgentRunFinalizationObligationRow = InferInsertModel<
  typeof agentRunFinalizationObligations
>;

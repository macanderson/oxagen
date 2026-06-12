import { relations } from "drizzle-orm";
import { organizations, orgUsers, invitations } from "./schema/org";
import {
  principals,
  roles,
  roleGrants,
  principalRoleAssignments,
  accessRequests,
} from "./schema/iam";
import { users, sessions, accounts, apiKeys } from "./schema/auth";
import { workspaces, workspaceUsers } from "./schema/workspace";
import {
  agents,
  agentVersions,
  agentExecutions,
  agentExecutionSteps,
  agentToolCalls,
  agentPlans,
  skills,
  skillVersions,
  backgroundTasks,
  approvalRequests,
  subagentFanouts,
  subagentRuns,
} from "./schema/agent";
import { mcpServers } from "./schema/mcp";
import {
  playbooks,
  playbookVersions,
  playbookSteps,
  playbookEdges,
  playbookTriggers,
  playbookRuns,
  playbookStepRuns,
  playbookEvents,
  playbookApprovals,
} from "./schema/workflow";
import { conversations, messages } from "./schema/chat";
import {
  plans,
  subscriptions,
  paymentMethods,
  invoices,
  invoiceLineItems,
  usageRecords,
  creditBalances,
  creditLedger,
  stripeEvents,
  stripeEventProcessing,
} from "./schema/billing";

// Cross-domain relations are declared here, not as Drizzle FK constraints,
// so that schema modules remain independent of one another. The actual FK
// DDL lives in the initial migration only for within-domain relationships;
// cross-domain joins are app-enforced per CLAUDE.md/spec §10.

export const organizationsRelations = relations(organizations, ({ many }) => ({
  orgUsers: many(orgUsers),
  invitations: many(invitations),
  workspaces: many(workspaces),
  subscriptions: many(subscriptions),
  paymentMethods: many(paymentMethods),
  invoices: many(invoices),
  apiKeys: many(apiKeys),
}));

export const invitationsRelations = relations(invitations, ({ one }) => ({
  org: one(organizations, { fields: [invitations.orgId], references: [organizations.id] }),
}));

export const orgUsersRelations = relations(orgUsers, ({ one }) => ({
  org: one(organizations, { fields: [orgUsers.orgId], references: [organizations.id] }),
  user: one(users, { fields: [orgUsers.userId], references: [users.id] }),
}));

export const usersRelations = relations(users, ({ many }) => ({
  orgMemberships: many(orgUsers),
  workspaceMemberships: many(workspaceUsers),
  sessions: many(sessions),
  accounts: many(accounts),
  conversations: many(conversations),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, { fields: [accounts.userId], references: [users.id] }),
}));

export const workspacesRelations = relations(workspaces, ({ one, many }) => ({
  org: one(organizations, { fields: [workspaces.orgId], references: [organizations.id] }),
  members: many(workspaceUsers),
}));

export const workspaceUsersRelations = relations(workspaceUsers, ({ one }) => ({
  workspace: one(workspaces, { fields: [workspaceUsers.workspaceId], references: [workspaces.id] }),
  user: one(users, { fields: [workspaceUsers.userId], references: [users.id] }),
}));


export const mcpServersRelations = relations(mcpServers, ({ one }) => ({
  org: one(organizations, { fields: [mcpServers.orgId], references: [organizations.id] }),
}));

// Agent-runtime epic relations. Cross-domain joins (messages, execution
// steps) stay app-enforced; in-domain links use Drizzle relations.

export const skillsRelations = relations(skills, ({ one, many }) => ({
  workspace: one(workspaces, { fields: [skills.workspaceId], references: [workspaces.id] }),
  versions: many(skillVersions),
}));

export const skillVersionsRelations = relations(skillVersions, ({ one }) => ({
  skill: one(skills, { fields: [skillVersions.skillId], references: [skills.id] }),
  parentVersion: one(skillVersions, {
    fields: [skillVersions.parentVersionId],
    references: [skillVersions.id],
    relationName: "skill_version_parent",
  }),
}));

export const backgroundTasksRelations = relations(backgroundTasks, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [backgroundTasks.workspaceId],
    references: [workspaces.id],
  }),
}));

export const approvalRequestsRelations = relations(approvalRequests, ({ one }) => ({
  message: one(messages, {
    fields: [approvalRequests.messageId],
    references: [messages.id],
  }),
}));

export const subagentFanoutsRelations = relations(subagentFanouts, ({ one, many }) => ({
  parentMessage: one(messages, {
    fields: [subagentFanouts.parentMessageId],
    references: [messages.id],
  }),
  runs: many(subagentRuns),
}));

export const subagentRunsRelations = relations(subagentRuns, ({ one }) => ({
  fanout: one(subagentFanouts, {
    fields: [subagentRuns.fanoutId],
    references: [subagentFanouts.id],
  }),
}));


export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  user: one(users, { fields: [conversations.userId], references: [users.id] }),
  activeLeafMessage: one(messages, {
    fields: [conversations.activeLeafMessageId],
    references: [messages.id],
    relationName: "conversation_active_leaf",
  }),
  messages: many(messages),
}));

export const messagesRelations = relations(messages, ({ one, many }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
  parent: one(messages, {
    fields: [messages.parentMessageId],
    references: [messages.id],
    relationName: "message_parent",
  }),
  children: many(messages, { relationName: "message_parent" }),
}));

export const plansRelations = relations(plans, ({ many }) => ({
  subscriptions: many(subscriptions),
}));

export const subscriptionsRelations = relations(subscriptions, ({ one, many }) => ({
  org: one(organizations, { fields: [subscriptions.orgId], references: [organizations.id] }),
  plan: one(plans, { fields: [subscriptions.planId], references: [plans.id] }),
  invoices: many(invoices),
  usageRecords: many(usageRecords),
}));

export const paymentMethodsRelations = relations(paymentMethods, ({ one }) => ({
  org: one(organizations, { fields: [paymentMethods.orgId], references: [organizations.id] }),
}));

export const invoicesRelations = relations(invoices, ({ one, many }) => ({
  org: one(organizations, { fields: [invoices.orgId], references: [organizations.id] }),
  subscription: one(subscriptions, {
    fields: [invoices.subscriptionId],
    references: [subscriptions.id],
  }),
  lineItems: many(invoiceLineItems),
}));

export const invoiceLineItemsRelations = relations(invoiceLineItems, ({ one }) => ({
  invoice: one(invoices, { fields: [invoiceLineItems.invoiceId], references: [invoices.id] }),
}));

export const usageRecordsRelations = relations(usageRecords, ({ one }) => ({
  org: one(organizations, { fields: [usageRecords.orgId], references: [organizations.id] }),
  subscription: one(subscriptions, {
    fields: [usageRecords.subscriptionId],
    references: [subscriptions.id],
  }),
}));

export const creditBalancesRelations = relations(creditBalances, ({ one }) => ({
  org: one(organizations, { fields: [creditBalances.orgId], references: [organizations.id] }),
}));

export const creditLedgerRelations = relations(creditLedger, ({ one }) => ({
  org: one(organizations, { fields: [creditLedger.orgId], references: [organizations.id] }),
}));

export const stripeEventsRelations = relations(stripeEvents, ({ one }) => ({
  processing: one(stripeEventProcessing, {
    fields: [stripeEvents.id],
    references: [stripeEventProcessing.stripeEventId],
  }),
}));

export const stripeEventProcessingRelations = relations(stripeEventProcessing, ({ one }) => ({
  event: one(stripeEvents, {
    fields: [stripeEventProcessing.stripeEventId],
    references: [stripeEvents.id],
  }),
}));

// ── IAM relations ─────────────────────────────────────────────────────────────
// Cross-domain FK to org.organizations stays app-enforced (not a Drizzle FK on
// the table builder) to match the existing pattern in this file. The in-domain
// links between IAM tables use Drizzle relations so the ORM can join them.

export const principalsRelations = relations(principals, ({ one, many }) => ({
  org: one(organizations, { fields: [principals.orgId], references: [organizations.id] }),
  roleAssignments: many(principalRoleAssignments),
  accessRequests: many(accessRequests),
}));

export const rolesRelations = relations(roles, ({ one, many }) => ({
  org: one(organizations, { fields: [roles.orgId], references: [organizations.id] }),
  roleGrants: many(roleGrants),
  principalAssignments: many(principalRoleAssignments),
  parentRole: one(roles, {
    fields: [roles.parentRoleId],
    references: [roles.id],
    relationName: "role_parent",
  }),
  childRoles: many(roles, { relationName: "role_parent" }),
}));

export const roleGrantsRelations = relations(roleGrants, ({ one }) => ({
  role: one(roles, { fields: [roleGrants.roleId], references: [roles.id] }),
  org: one(organizations, { fields: [roleGrants.orgId], references: [organizations.id] }),
}));

export const principalRoleAssignmentsRelations = relations(principalRoleAssignments, ({ one }) => ({
  principal: one(principals, { fields: [principalRoleAssignments.principalId], references: [principals.id] }),
  role: one(roles, { fields: [principalRoleAssignments.roleId], references: [roles.id] }),
  org: one(organizations, { fields: [principalRoleAssignments.orgId], references: [organizations.id] }),
}));

export const accessRequestsRelations = relations(accessRequests, ({ one }) => ({
  requester: one(principals, { fields: [accessRequests.requesterId], references: [principals.id] }),
  org: one(organizations, { fields: [accessRequests.orgId], references: [organizations.id] }),
}));

// ── Agent relations ───────────────────────────────────────────────────────────

export const agentsRelations = relations(agents, ({ one, many }) => ({
  workspace: one(workspaces, { fields: [agents.workspaceId], references: [workspaces.id] }),
  versions: many(agentVersions),
  executions: many(agentExecutions),
}));

export const agentVersionsRelations = relations(agentVersions, ({ one, many }) => ({
  agent: one(agents, { fields: [agentVersions.agentId], references: [agents.id] }),
  executions: many(agentExecutions),
  stepRuns: many(playbookStepRuns),
}));

export const agentExecutionsRelations = relations(agentExecutions, ({ one, many }) => ({
  agent: one(agents, { fields: [agentExecutions.agentId], references: [agents.id] }),
  agentVersion: one(agentVersions, {
    fields: [agentExecutions.agentVersionId],
    references: [agentVersions.id],
  }),
  workspace: one(workspaces, { fields: [agentExecutions.workspaceId], references: [workspaces.id] }),
  steps: many(agentExecutionSteps),
}));

export const agentExecutionStepsRelations = relations(agentExecutionSteps, ({ one, many }) => ({
  execution: one(agentExecutions, {
    fields: [agentExecutionSteps.executionId],
    references: [agentExecutions.id],
  }),
  toolCalls: many(agentToolCalls),
}));

export const agentToolCallsRelations = relations(agentToolCalls, ({ one }) => ({
  executionStep: one(agentExecutionSteps, {
    fields: [agentToolCalls.executionStepId],
    references: [agentExecutionSteps.id],
  }),
}));

export const agentPlansRelations = relations(agentPlans, ({ one }) => ({
  workspace: one(workspaces, { fields: [agentPlans.workspaceId], references: [workspaces.id] }),
}));

// ── Playbook (workflow domain) relations ──────────────────────────────────────

export const playbooksRelations = relations(playbooks, ({ one, many }) => ({
  workspace: one(workspaces, { fields: [playbooks.workspaceId], references: [workspaces.id] }),
  versions: many(playbookVersions),
  triggers: many(playbookTriggers),
  runs: many(playbookRuns),
}));

export const playbookVersionsRelations = relations(playbookVersions, ({ one, many }) => ({
  playbook: one(playbooks, { fields: [playbookVersions.playbookId], references: [playbooks.id] }),
  steps: many(playbookSteps),
  edges: many(playbookEdges),
  runs: many(playbookRuns),
}));

export const playbookStepsRelations = relations(playbookSteps, ({ one, many }) => ({
  version: one(playbookVersions, {
    fields: [playbookSteps.playbookVersionId],
    references: [playbookVersions.id],
  }),
  outboundEdges: many(playbookEdges, { relationName: "edge_source" }),
  inboundEdges: many(playbookEdges, { relationName: "edge_target" }),
  stepRuns: many(playbookStepRuns),
}));

export const playbookEdgesRelations = relations(playbookEdges, ({ one }) => ({
  version: one(playbookVersions, {
    fields: [playbookEdges.playbookVersionId],
    references: [playbookVersions.id],
  }),
  sourceStep: one(playbookSteps, {
    fields: [playbookEdges.sourceStepId],
    references: [playbookSteps.id],
    relationName: "edge_source",
  }),
  targetStep: one(playbookSteps, {
    fields: [playbookEdges.targetStepId],
    references: [playbookSteps.id],
    relationName: "edge_target",
  }),
}));

export const playbookTriggersRelations = relations(playbookTriggers, ({ one }) => ({
  playbook: one(playbooks, { fields: [playbookTriggers.playbookId], references: [playbooks.id] }),
  workspace: one(workspaces, { fields: [playbookTriggers.workspaceId], references: [workspaces.id] }),
}));

export const playbookRunsRelations = relations(playbookRuns, ({ one, many }) => ({
  playbook: one(playbooks, { fields: [playbookRuns.playbookId], references: [playbooks.id] }),
  version: one(playbookVersions, {
    fields: [playbookRuns.playbookVersionId],
    references: [playbookVersions.id],
  }),
  workspace: one(workspaces, { fields: [playbookRuns.workspaceId], references: [workspaces.id] }),
  parentRun: one(playbookRuns, {
    fields: [playbookRuns.parentRunId],
    references: [playbookRuns.id],
    relationName: "playbook_run_parent",
  }),
  childRuns: many(playbookRuns, { relationName: "playbook_run_parent" }),
  stepRuns: many(playbookStepRuns),
  events: many(playbookEvents),
  approvals: many(playbookApprovals),
}));

export const playbookStepRunsRelations = relations(playbookStepRuns, ({ one, many }) => ({
  run: one(playbookRuns, {
    fields: [playbookStepRuns.playbookRunId],
    references: [playbookRuns.id],
  }),
  step: one(playbookSteps, {
    fields: [playbookStepRuns.playbookStepId],
    references: [playbookSteps.id],
  }),
  agentVersion: one(agentVersions, {
    fields: [playbookStepRuns.agentVersionId],
    references: [agentVersions.id],
  }),
  events: many(playbookEvents),
  approvals: many(playbookApprovals),
}));

export const playbookEventsRelations = relations(playbookEvents, ({ one }) => ({
  run: one(playbookRuns, {
    fields: [playbookEvents.playbookRunId],
    references: [playbookRuns.id],
  }),
  stepRun: one(playbookStepRuns, {
    fields: [playbookEvents.stepRunId],
    references: [playbookStepRuns.id],
  }),
}));

export const playbookApprovalsRelations = relations(playbookApprovals, ({ one }) => ({
  run: one(playbookRuns, {
    fields: [playbookApprovals.playbookRunId],
    references: [playbookRuns.id],
  }),
  stepRun: one(playbookStepRuns, {
    fields: [playbookApprovals.stepRunId],
    references: [playbookStepRuns.id],
  }),
}));


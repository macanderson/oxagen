import { relations } from "drizzle-orm";
import { organizations, orgUsers, invitations } from "./schema/org";
import {
  principals,
  roles,
  roleGrants,
  grants,
  accessRequests,
} from "./schema/iam";
import { users, sessions, accounts, apiKeys, credentials } from "./schema/auth";
import { workspaces, workspaceUsers } from "./schema/workspace";
import {
  agents,
  agentVersions,
  mcpServers,
  skills,
  skillVersions,
  backgroundTasks,
  approvalRequests,
  subagentFanouts,
  subagentRuns,
  planSteps,
} from "./schema/agent";
import {
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



export const agentsRelations = relations(agents, ({ many }) => ({
  versions: many(agentVersions),
}));

export const agentVersionsRelations = relations(agentVersions, ({ one }) => ({
  agent: one(agents, { fields: [agentVersions.agentId], references: [agents.id] }),
  parentVersion: one(agentVersions, {
    fields: [agentVersions.parentVersionId],
    references: [agentVersions.id],
    relationName: "agent_version_parent",
  }),
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
  agentVersion: one(agentVersions, {
    fields: [conversations.agentVersionId],
    references: [agentVersions.id],
  }),
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
  grants: many(grants),
  accessRequests: many(accessRequests),
}));

export const rolesRelations = relations(roles, ({ one, many }) => ({
  org: one(organizations, { fields: [roles.orgId], references: [organizations.id] }),
  roleGrants: many(roleGrants),
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

export const grantsRelations = relations(grants, ({ one }) => ({
  principal: one(principals, { fields: [grants.principalId], references: [principals.id] }),
  org: one(organizations, { fields: [grants.orgId], references: [organizations.id] }),
}));

export const accessRequestsRelations = relations(accessRequests, ({ one }) => ({
  requester: one(principals, { fields: [accessRequests.requesterId], references: [principals.id] }),
  org: one(organizations, { fields: [accessRequests.orgId], references: [organizations.id] }),
}));

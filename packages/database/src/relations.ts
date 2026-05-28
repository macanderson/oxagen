import { relations } from "drizzle-orm";
import { tenants, tenantUsers } from "./schema/organization.js";
import { users, sessions, accounts, apiKeys, credentials } from "./schema/auth.js";
import { workspaces, workspaceUsers, folders } from "./schema/workspace.js";
import { connections, connectionSyncJobs } from "./schema/integration.js";
import {
  agents,
  agentVersions,
  tools,
  toolVersions,
  toolAssignments,
  mcpServers,
  skills,
  skillVersions,
  backgroundTasks,
  approvalRequests,
  subagentFanouts,
  subagentRuns,
  planSteps,
} from "./schema/agent.js";
import {
  playbooks,
  playbookVersions,
  playbookSteps,
  playbookStepAssignments,
  promptTemplates,
  promptTemplateVersions,
} from "./schema/workflow.js";
import { triggers, workflowTriggers } from "./schema/event.js";
import { executions, executionSteps, toolCalls, executionArtifacts } from "./schema/execution.js";
import { conversations, messages } from "./schema/chat.js";
import { files, documents, contentGenerations } from "./schema/content.js";
import { graphProviders, routingRules } from "./schema/graph.js";
import { evals, evalRuns } from "./schema/evaluation.js";
import {
  plans,
  subscriptions,
  paymentMethods,
  invoices,
  invoiceLineItems,
  usageRecords,
  creditBalances,
  creditLedger,
} from "./schema/billing.js";

// Cross-domain relations are declared here, not as Drizzle FK constraints,
// so that schema modules remain independent of one another. The actual FK
// DDL lives in the initial migration only for within-domain relationships;
// cross-domain joins are app-enforced per CLAUDE.md/spec §10.

export const tenantsRelations = relations(tenants, ({ many }) => ({
  tenantUsers: many(tenantUsers),
  workspaces: many(workspaces),
  subscriptions: many(subscriptions),
  paymentMethods: many(paymentMethods),
  invoices: many(invoices),
  apiKeys: many(apiKeys),
}));

export const tenantUsersRelations = relations(tenantUsers, ({ one }) => ({
  tenant: one(tenants, { fields: [tenantUsers.tenantId], references: [tenants.id] }),
  user: one(users, { fields: [tenantUsers.userId], references: [users.id] }),
}));

export const usersRelations = relations(users, ({ many }) => ({
  tenantMemberships: many(tenantUsers),
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
  tenant: one(tenants, { fields: [workspaces.tenantId], references: [tenants.id] }),
  members: many(workspaceUsers),
  folders: many(folders),
}));

export const workspaceUsersRelations = relations(workspaceUsers, ({ one }) => ({
  workspace: one(workspaces, { fields: [workspaceUsers.workspaceId], references: [workspaces.id] }),
  user: one(users, { fields: [workspaceUsers.userId], references: [users.id] }),
}));

export const foldersRelations = relations(folders, ({ one, many }) => ({
  parent: one(folders, {
    fields: [folders.parentFolderId],
    references: [folders.id],
    relationName: "folder_parent",
  }),
  children: many(folders, { relationName: "folder_parent" }),
  documents: many(documents),
}));

export const connectionsRelations = relations(connections, ({ one, many }) => ({
  credential: one(credentials, {
    fields: [connections.credentialId],
    references: [credentials.id],
  }),
  syncJobs: many(connectionSyncJobs),
}));

export const connectionSyncJobsRelations = relations(connectionSyncJobs, ({ one }) => ({
  connection: one(connections, {
    fields: [connectionSyncJobs.connectionId],
    references: [connections.id],
  }),
}));

export const agentsRelations = relations(agents, ({ many }) => ({
  versions: many(agentVersions),
}));

export const agentVersionsRelations = relations(agentVersions, ({ one, many }) => ({
  agent: one(agents, { fields: [agentVersions.agentId], references: [agents.id] }),
  parentVersion: one(agentVersions, {
    fields: [agentVersions.parentVersionId],
    references: [agentVersions.id],
    relationName: "agent_version_parent",
  }),
  toolAssignments: many(toolAssignments),
}));

export const toolsRelations = relations(tools, ({ many }) => ({
  versions: many(toolVersions),
}));

export const toolVersionsRelations = relations(toolVersions, ({ one, many }) => ({
  tool: one(tools, { fields: [toolVersions.toolId], references: [tools.id] }),
  assignments: many(toolAssignments),
}));

export const toolAssignmentsRelations = relations(toolAssignments, ({ one }) => ({
  agentVersion: one(agentVersions, {
    fields: [toolAssignments.agentVersionId],
    references: [agentVersions.id],
  }),
  toolVersion: one(toolVersions, {
    fields: [toolAssignments.toolVersionId],
    references: [toolVersions.id],
  }),
}));

export const mcpServersRelations = relations(mcpServers, ({ one }) => ({
  tenant: one(tenants, { fields: [mcpServers.tenantId], references: [tenants.id] }),
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

export const planStepsRelations = relations(planSteps, ({ one }) => ({
  executionStep: one(executionSteps, {
    fields: [planSteps.executionStepId],
    references: [executionSteps.id],
  }),
}));

export const playbooksRelations = relations(playbooks, ({ many }) => ({
  versions: many(playbookVersions),
}));

export const playbookVersionsRelations = relations(playbookVersions, ({ one, many }) => ({
  playbook: one(playbooks, { fields: [playbookVersions.playbookId], references: [playbooks.id] }),
  steps: many(playbookSteps),
  triggers: many(workflowTriggers),
}));

export const playbookStepsRelations = relations(playbookSteps, ({ one, many }) => ({
  version: one(playbookVersions, {
    fields: [playbookSteps.playbookVersionId],
    references: [playbookVersions.id],
  }),
  promptTemplate: one(promptTemplates, {
    fields: [playbookSteps.promptTemplateId],
    references: [promptTemplates.id],
  }),
  assignments: many(playbookStepAssignments),
}));

export const playbookStepAssignmentsRelations = relations(playbookStepAssignments, ({ one }) => ({
  step: one(playbookSteps, {
    fields: [playbookStepAssignments.playbookStepId],
    references: [playbookSteps.id],
  }),
  agentVersion: one(agentVersions, {
    fields: [playbookStepAssignments.agentVersionId],
    references: [agentVersions.id],
  }),
}));

export const promptTemplatesRelations = relations(promptTemplates, ({ many }) => ({
  versions: many(promptTemplateVersions),
}));

export const promptTemplateVersionsRelations = relations(promptTemplateVersions, ({ one }) => ({
  template: one(promptTemplates, {
    fields: [promptTemplateVersions.promptTemplateId],
    references: [promptTemplates.id],
  }),
}));

export const triggersRelations = relations(triggers, ({ many }) => ({
  workflowTriggers: many(workflowTriggers),
}));

export const workflowTriggersRelations = relations(workflowTriggers, ({ one }) => ({
  trigger: one(triggers, { fields: [workflowTriggers.triggerId], references: [triggers.id] }),
  playbookVersion: one(playbookVersions, {
    fields: [workflowTriggers.playbookVersionId],
    references: [playbookVersions.id],
  }),
}));

export const executionsRelations = relations(executions, ({ one, many }) => ({
  playbookVersion: one(playbookVersions, {
    fields: [executions.playbookVersionId],
    references: [playbookVersions.id],
  }),
  triggeredByMessage: one(messages, {
    fields: [executions.triggeredByMessageId],
    references: [messages.id],
  }),
  steps: many(executionSteps),
  artifacts: many(executionArtifacts),
}));

export const executionStepsRelations = relations(executionSteps, ({ one, many }) => ({
  execution: one(executions, { fields: [executionSteps.executionId], references: [executions.id] }),
  playbookStep: one(playbookSteps, {
    fields: [executionSteps.playbookStepId],
    references: [playbookSteps.id],
  }),
  agentVersion: one(agentVersions, {
    fields: [executionSteps.agentVersionId],
    references: [agentVersions.id],
  }),
  toolCalls: many(toolCalls),
}));

export const toolCallsRelations = relations(toolCalls, ({ one }) => ({
  step: one(executionSteps, {
    fields: [toolCalls.executionStepId],
    references: [executionSteps.id],
  }),
  toolVersion: one(toolVersions, {
    fields: [toolCalls.toolVersionId],
    references: [toolVersions.id],
  }),
}));

export const executionArtifactsRelations = relations(executionArtifacts, ({ one }) => ({
  execution: one(executions, {
    fields: [executionArtifacts.executionId],
    references: [executions.id],
  }),
  document: one(documents, {
    fields: [executionArtifacts.documentId],
    references: [documents.id],
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

export const filesRelations = relations(files, ({ many }) => ({
  documents: many(documents),
}));

export const documentsRelations = relations(documents, ({ one }) => ({
  file: one(files, { fields: [documents.fileId], references: [files.id] }),
  folder: one(folders, { fields: [documents.folderId], references: [folders.id] }),
}));

export const contentGenerationsRelations = relations(contentGenerations, ({ one }) => ({
  step: one(executionSteps, {
    fields: [contentGenerations.executionStepId],
    references: [executionSteps.id],
  }),
  outputDocument: one(documents, {
    fields: [contentGenerations.outputDocumentId],
    references: [documents.id],
  }),
}));

export const graphProvidersRelations = relations(graphProviders, ({ one }) => ({
  connection: one(connections, {
    fields: [graphProviders.connectionId],
    references: [connections.id],
  }),
}));

export const routingRulesRelations = relations(routingRules, ({ one }) => ({
  targetGraph: one(graphProviders, {
    fields: [routingRules.targetGraphId],
    references: [graphProviders.id],
  }),
}));

export const evalsRelations = relations(evals, ({ many }) => ({
  runs: many(evalRuns),
}));

export const evalRunsRelations = relations(evalRuns, ({ one }) => ({
  eval: one(evals, { fields: [evalRuns.evalId], references: [evals.id] }),
  agentVersion: one(agentVersions, {
    fields: [evalRuns.agentVersionId],
    references: [agentVersions.id],
  }),
}));

export const plansRelations = relations(plans, ({ many }) => ({
  subscriptions: many(subscriptions),
}));

export const subscriptionsRelations = relations(subscriptions, ({ one, many }) => ({
  tenant: one(tenants, { fields: [subscriptions.tenantId], references: [tenants.id] }),
  plan: one(plans, { fields: [subscriptions.planId], references: [plans.id] }),
  invoices: many(invoices),
  usageRecords: many(usageRecords),
}));

export const paymentMethodsRelations = relations(paymentMethods, ({ one }) => ({
  tenant: one(tenants, { fields: [paymentMethods.tenantId], references: [tenants.id] }),
}));

export const invoicesRelations = relations(invoices, ({ one, many }) => ({
  tenant: one(tenants, { fields: [invoices.tenantId], references: [tenants.id] }),
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
  tenant: one(tenants, { fields: [usageRecords.tenantId], references: [tenants.id] }),
  subscription: one(subscriptions, {
    fields: [usageRecords.subscriptionId],
    references: [subscriptions.id],
  }),
}));

export const creditBalancesRelations = relations(creditBalances, ({ one }) => ({
  tenant: one(tenants, { fields: [creditBalances.tenantId], references: [tenants.id] }),
}));

export const creditLedgerRelations = relations(creditLedger, ({ one }) => ({
  tenant: one(tenants, { fields: [creditLedger.tenantId], references: [tenants.id] }),
}));

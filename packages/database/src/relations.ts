import { relations } from "drizzle-orm";
import {
  schemaRegistries,
  schemaVersions,
  schemas,
  schemaActivations,
  nodeLabels,
  relationshipTypes,
  schemaProperties,
} from "./schema/schema-registry";
import {
  organizations,
  orgUsers,
  invitations,
  dataPlanes,
} from "./schema/org";
import {
  principals,
  roles,
  roleGrants,
  principalRoleAssignments,
  accessRequests,
  authorizationSnapshots,
  authorizationDecisions,
} from "./schema/iam";
import {
  sourceConnections,
  repositoryBindings,
  repositoryBindingHeads,
} from "./schema/ingestion";
import { users, sessions, accounts, apiKeys } from "./schema/auth";
import { workspaces, workspaceUsers } from "./schema/workspace";
import {
  agents,
  agentVersions,
  agentExecutions,
  agentExecutionSteps,
  agentToolCalls,
  tools,
  toolVersions,
  contextRecords,
  contextRecordVersions,
  contextPromotions,
  approvalRequests,
  agentRuns,
  agentRunEvents,
  agentRunAttempts,
  agentRunAttemptSeals,
  agentRunFinalizationGrants,
  agentRunFinalizationObligations,
} from "./schema/agent";
import { mcpServers, mcpConsents, mcpToolSnapshots } from "./schema/mcp";
import { mcpServerChanges } from "./schema/security";
import { conversations, messages } from "./schema/chat";
import {
  plans,
  subscriptions,
  paymentMethods,
  invoices,
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
  dataPlanes: many(dataPlanes),
}));

/**
 * ADR-042 organisation-scoped store bindings. One row per (organisation, store
 * kind); the `org` back-reference is the only join this table ever needs.
 */
export const dataPlanesRelations = relations(dataPlanes, ({ one }) => ({
  org: one(organizations, {
    fields: [dataPlanes.orgId],
    references: [organizations.id],
  }),
}));

export const invitationsRelations = relations(invitations, ({ one }) => ({
  org: one(organizations, {
    fields: [invitations.orgId],
    references: [organizations.id],
  }),
}));

export const orgUsersRelations = relations(orgUsers, ({ one }) => ({
  org: one(organizations, {
    fields: [orgUsers.orgId],
    references: [organizations.id],
  }),
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
  org: one(organizations, {
    fields: [workspaces.orgId],
    references: [organizations.id],
  }),
  members: many(workspaceUsers),
}));

export const workspaceUsersRelations = relations(workspaceUsers, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [workspaceUsers.workspaceId],
    references: [workspaces.id],
  }),
  user: one(users, { fields: [workspaceUsers.userId], references: [users.id] }),
}));

export const mcpServersRelations = relations(mcpServers, ({ one, many }) => ({
  org: one(organizations, {
    fields: [mcpServers.orgId],
    references: [organizations.id],
  }),
  consents: many(mcpConsents),
  toolSnapshots: many(mcpToolSnapshots),
}));

// External-MCP consent grants. Each row links a server + the granting
// user; the server link is the in-domain relation.
export const mcpConsentsRelations = relations(mcpConsents, ({ one }) => ({
  org: one(organizations, {
    fields: [mcpConsents.orgId],
    references: [organizations.id],
  }),
  server: one(mcpServers, {
    fields: [mcpConsents.mcpServerId],
    references: [mcpServers.id],
  }),
  user: one(users, { fields: [mcpConsents.userId], references: [users.id] }),
}));

// External-MCP tool-descriptor snapshots.
export const mcpToolSnapshotsRelations = relations(
  mcpToolSnapshots,
  ({ one }) => ({
    org: one(organizations, {
      fields: [mcpToolSnapshots.orgId],
      references: [organizations.id],
    }),
    server: one(mcpServers, {
      fields: [mcpToolSnapshots.mcpServerId],
      references: [mcpServers.id],
    }),
  }),
);

// External-MCP server lifecycle audit. Append-only; references the
// server + the acting user, both app-enforced.
export const mcpServerChangesRelations = relations(
  mcpServerChanges,
  ({ one }) => ({
    org: one(organizations, {
      fields: [mcpServerChanges.orgId],
      references: [organizations.id],
    }),
    server: one(mcpServers, {
      fields: [mcpServerChanges.serverId],
      references: [mcpServers.id],
    }),
  }),
);

// Agent relations. Cross-domain joins (messages, execution steps) stay
// app-enforced; in-domain links use Drizzle relations.

// Workspace agent-asset registry (stella-cutover Wave 4): identity ↔ versions,
// plus the append-only promotions ledger for context records.

export const toolsRelations = relations(tools, ({ one, many }) => ({
  workspace: one(workspaces, {
    fields: [tools.workspaceId],
    references: [workspaces.id],
  }),
  versions: many(toolVersions),
}));

export const toolVersionsRelations = relations(toolVersions, ({ one }) => ({
  tool: one(tools, {
    fields: [toolVersions.toolId],
    references: [tools.id],
  }),
  parentVersion: one(toolVersions, {
    fields: [toolVersions.parentVersionId],
    references: [toolVersions.id],
    relationName: "tool_version_parent",
  }),
}));

export const contextRecordsRelations = relations(
  contextRecords,
  ({ one, many }) => ({
    workspace: one(workspaces, {
      fields: [contextRecords.workspaceId],
      references: [workspaces.id],
    }),
    versions: many(contextRecordVersions),
    promotions: many(contextPromotions),
  }),
);

export const contextRecordVersionsRelations = relations(
  contextRecordVersions,
  ({ one }) => ({
    record: one(contextRecords, {
      fields: [contextRecordVersions.recordId],
      references: [contextRecords.id],
    }),
    parentVersion: one(contextRecordVersions, {
      fields: [contextRecordVersions.parentVersionId],
      references: [contextRecordVersions.id],
      relationName: "context_record_version_parent",
    }),
  }),
);

export const contextPromotionsRelations = relations(
  contextPromotions,
  ({ one }) => ({
    record: one(contextRecords, {
      fields: [contextPromotions.recordId],
      references: [contextRecords.id],
    }),
    version: one(contextRecordVersions, {
      fields: [contextPromotions.versionId],
      references: [contextRecordVersions.id],
    }),
  }),
);

export const approvalRequestsRelations = relations(
  approvalRequests,
  ({ one }) => ({
    message: one(messages, {
      fields: [approvalRequests.messageId],
      references: [messages.id],
    }),
  }),
);

export const conversationsRelations = relations(
  conversations,
  ({ one, many }) => ({
    user: one(users, {
      fields: [conversations.userId],
      references: [users.id],
    }),
    activeLeafMessage: one(messages, {
      fields: [conversations.activeLeafMessageId],
      references: [messages.id],
      relationName: "conversation_active_leaf",
    }),
    messages: many(messages),
  }),
);

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

export const subscriptionsRelations = relations(
  subscriptions,
  ({ one, many }) => ({
    org: one(organizations, {
      fields: [subscriptions.orgId],
      references: [organizations.id],
    }),
    plan: one(plans, {
      fields: [subscriptions.planId],
      references: [plans.id],
    }),
    invoices: many(invoices),
  }),
);

export const paymentMethodsRelations = relations(paymentMethods, ({ one }) => ({
  org: one(organizations, {
    fields: [paymentMethods.orgId],
    references: [organizations.id],
  }),
}));

export const invoicesRelations = relations(invoices, ({ one }) => ({
  org: one(organizations, {
    fields: [invoices.orgId],
    references: [organizations.id],
  }),
  subscription: one(subscriptions, {
    fields: [invoices.subscriptionId],
    references: [subscriptions.id],
  }),
}));

export const creditBalancesRelations = relations(creditBalances, ({ one }) => ({
  org: one(organizations, {
    fields: [creditBalances.orgId],
    references: [organizations.id],
  }),
}));

export const creditLedgerRelations = relations(creditLedger, ({ one }) => ({
  org: one(organizations, {
    fields: [creditLedger.orgId],
    references: [organizations.id],
  }),
}));

export const stripeEventsRelations = relations(stripeEvents, ({ one }) => ({
  processing: one(stripeEventProcessing, {
    fields: [stripeEvents.id],
    references: [stripeEventProcessing.stripeEventId],
  }),
}));

export const stripeEventProcessingRelations = relations(
  stripeEventProcessing,
  ({ one }) => ({
    event: one(stripeEvents, {
      fields: [stripeEventProcessing.stripeEventId],
      references: [stripeEvents.id],
    }),
  }),
);

// ── IAM relations ─────────────────────────────────────────────────────────────
// Cross-domain FK to org.organizations stays app-enforced (not a Drizzle FK on
// the table builder) to match the existing pattern in this file. The in-domain
// links between IAM tables use Drizzle relations so the ORM can join them.

export const principalsRelations = relations(principals, ({ one, many }) => ({
  org: one(organizations, {
    fields: [principals.orgId],
    references: [organizations.id],
  }),
  roleAssignments: many(principalRoleAssignments),
  accessRequests: many(accessRequests),
}));

export const rolesRelations = relations(roles, ({ one, many }) => ({
  org: one(organizations, {
    fields: [roles.orgId],
    references: [organizations.id],
  }),
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
  org: one(organizations, {
    fields: [roleGrants.orgId],
    references: [organizations.id],
  }),
}));

export const principalRoleAssignmentsRelations = relations(
  principalRoleAssignments,
  ({ one }) => ({
    principal: one(principals, {
      fields: [principalRoleAssignments.principalId],
      references: [principals.id],
    }),
    role: one(roles, {
      fields: [principalRoleAssignments.roleId],
      references: [roles.id],
    }),
    org: one(organizations, {
      fields: [principalRoleAssignments.orgId],
      references: [organizations.id],
    }),
  }),
);

export const accessRequestsRelations = relations(accessRequests, ({ one }) => ({
  requester: one(principals, {
    fields: [accessRequests.requesterId],
    references: [principals.id],
  }),
  org: one(organizations, {
    fields: [accessRequests.orgId],
    references: [organizations.id],
  }),
}));

// ── Agent relations ───────────────────────────────────────────────────────────

export const agentsRelations = relations(agents, ({ one, many }) => ({
  workspace: one(workspaces, {
    fields: [agents.workspaceId],
    references: [workspaces.id],
  }),
  versions: many(agentVersions),
  executions: many(agentExecutions),
}));

export const agentVersionsRelations = relations(
  agentVersions,
  ({ one, many }) => ({
    agent: one(agents, {
      fields: [agentVersions.agentId],
      references: [agents.id],
    }),
    executions: many(agentExecutions),
  }),
);

export const agentExecutionsRelations = relations(
  agentExecutions,
  ({ one, many }) => ({
    agent: one(agents, {
      fields: [agentExecutions.agentId],
      references: [agents.id],
    }),
    agentVersion: one(agentVersions, {
      fields: [agentExecutions.agentVersionId],
      references: [agentVersions.id],
    }),
    workspace: one(workspaces, {
      fields: [agentExecutions.workspaceId],
      references: [workspaces.id],
    }),
    steps: many(agentExecutionSteps),
  }),
);

export const agentExecutionStepsRelations = relations(
  agentExecutionSteps,
  ({ one, many }) => ({
    execution: one(agentExecutions, {
      fields: [agentExecutionSteps.executionId],
      references: [agentExecutions.id],
    }),
    toolCalls: many(agentToolCalls),
  }),
);

export const agentToolCallsRelations = relations(agentToolCalls, ({ one }) => ({
  executionStep: one(agentExecutionSteps, {
    fields: [agentToolCalls.executionStepId],
    references: [agentExecutionSteps.id],
  }),
}));

// ── Schema Registry relations (§4.1–§4.6) ────────────────────────────────────
// Cross-domain joins are app-enforced; in-domain FK links use Drizzle relations.

export const schemaRegistriesRelations = relations(
  schemaRegistries,
  ({ one, many }) => ({
    // The currently pinned (immutable, published) version.
    pinnedVersion: one(schemaVersions, {
      fields: [schemaRegistries.pinnedVersionId],
      references: [schemaVersions.id],
      relationName: "registry_pinned_version",
    }),
    // The current mutable draft version.
    draftVersion: one(schemaVersions, {
      fields: [schemaRegistries.draftVersionId],
      references: [schemaVersions.id],
      relationName: "registry_draft_version",
    }),
    versions: many(schemaVersions),
  }),
);

export const schemaVersionsRelations = relations(
  schemaVersions,
  ({ one, many }) => ({
    registry: one(schemaRegistries, {
      fields: [schemaVersions.registryId],
      references: [schemaRegistries.id],
    }),
    parentVersion: one(schemaVersions, {
      fields: [schemaVersions.parentVersionId],
      references: [schemaVersions.id],
      relationName: "schema_version_parent",
    }),
    childVersions: many(schemaVersions, {
      relationName: "schema_version_parent",
    }),
    schemas: many(schemas),
  }),
);

export const schemasRelations = relations(schemas, ({ one, many }) => ({
  version: one(schemaVersions, {
    fields: [schemas.versionId],
    references: [schemaVersions.id],
  }),
  nodeLabels: many(nodeLabels),
  relationshipTypes: many(relationshipTypes),
}));

export const schemaActivationsRelations = relations(
  schemaActivations,
  (_helpers) => ({
    // schema_activations is keyed on schema_name (stable string identity), not a UUID FK.
    // Cross-workspace lookups are app-enforced; no Drizzle join needed here.
  }),
);

export const nodeLabelsRelations = relations(nodeLabels, ({ one, many }) => ({
  version: one(schemaVersions, {
    fields: [nodeLabels.versionId],
    references: [schemaVersions.id],
  }),
  schema: one(schemas, {
    fields: [nodeLabels.schemaId],
    references: [schemas.id],
  }),
  properties: many(schemaProperties),
}));

export const relationshipTypesRelations = relations(
  relationshipTypes,
  ({ one, many }) => ({
    version: one(schemaVersions, {
      fields: [relationshipTypes.versionId],
      references: [schemaVersions.id],
    }),
    schema: one(schemas, {
      fields: [relationshipTypes.schemaId],
      references: [schemas.id],
    }),
    properties: many(schemaProperties),
  }),
);

export const schemaPropertiesRelations = relations(
  schemaProperties,
  ({ one }) => ({
    version: one(schemaVersions, {
      fields: [schemaProperties.versionId],
      references: [schemaVersions.id],
    }),
    nodeLabel: one(nodeLabels, {
      fields: [schemaProperties.nodeLabelId],
      references: [nodeLabels.id],
    }),
    relationshipType: one(relationshipTypes, {
      fields: [schemaProperties.relationshipTypeId],
      references: [relationshipTypes.id],
    }),
  }),
);

// ── Fenced run/attempt foundation (docs/specs/run-evidence-ingress) ──────────
//
// These are Drizzle query relations only — the underlying columns carry NO
// database foreign keys, per the cross-schema storage rule. They exist so a
// caller can traverse run → attempts → seal → grant → obligation in one typed
// query instead of hand-joining on app-enforced ids.
export const agentRunsFoundationRelations = relations(
  agentRuns,
  ({ many }) => ({
    attempts: many(agentRunAttempts),
    events: many(agentRunEvents),
  }),
);

export const agentRunAttemptsRelations = relations(
  agentRunAttempts,
  ({ one, many }) => ({
    run: one(agentRuns, {
      fields: [agentRunAttempts.runId],
      references: [agentRuns.id],
    }),
    // At most one seal per attempt (unique index).
    seal: one(agentRunAttemptSeals, {
      fields: [agentRunAttempts.id],
      references: [agentRunAttemptSeals.attemptId],
    }),
    events: many(agentRunEvents),
  }),
);

export const agentRunEventsRelations = relations(agentRunEvents, ({ one }) => ({
  run: one(agentRuns, {
    fields: [agentRunEvents.runId],
    references: [agentRuns.id],
  }),
  // Null for every V1 legacy row — only V2 records belong to an attempt.
  attempt: one(agentRunAttempts, {
    fields: [agentRunEvents.attemptId],
    references: [agentRunAttempts.id],
  }),
}));

export const agentRunAttemptSealsRelations = relations(
  agentRunAttemptSeals,
  ({ one }) => ({
    attempt: one(agentRunAttempts, {
      fields: [agentRunAttemptSeals.attemptId],
      references: [agentRunAttempts.id],
    }),
    // Every seal mints exactly one finalization grant in the same transaction.
    finalizationGrant: one(agentRunFinalizationGrants, {
      fields: [agentRunAttemptSeals.id],
      references: [agentRunFinalizationGrants.sealId],
    }),
  }),
);

export const agentRunFinalizationGrantsRelations = relations(
  agentRunFinalizationGrants,
  ({ one }) => ({
    seal: one(agentRunAttemptSeals, {
      fields: [agentRunFinalizationGrants.sealId],
      references: [agentRunAttemptSeals.id],
    }),
    obligation: one(agentRunFinalizationObligations, {
      fields: [agentRunFinalizationGrants.id],
      references: [agentRunFinalizationObligations.grantId],
    }),
  }),
);

export const agentRunFinalizationObligationsRelations = relations(
  agentRunFinalizationObligations,
  ({ one }) => ({
    grant: one(agentRunFinalizationGrants, {
      fields: [agentRunFinalizationObligations.grantId],
      references: [agentRunFinalizationGrants.id],
    }),
  }),
);

// Governed repository bindings: the immutable version chain plus the mutable
// head pointer admission resolves through.
export const repositoryBindingsRelations = relations(
  repositoryBindings,
  ({ one }) => ({
    connection: one(sourceConnections, {
      fields: [repositoryBindings.connectionId],
      references: [sourceConnections.id],
    }),
  }),
);

export const repositoryBindingHeadsRelations = relations(
  repositoryBindingHeads,
  ({ one }) => ({
    currentBinding: one(repositoryBindings, {
      fields: [repositoryBindingHeads.currentBindingId],
      references: [repositoryBindings.id],
    }),
  }),
);

// Authorization foundation: a decision names the pinned snapshot it was
// evaluated against, so an audit read never has to guess which ceiling applied.
export const authorizationDecisionsRelations = relations(
  authorizationDecisions,
  ({ one }) => ({
    snapshot: one(authorizationSnapshots, {
      fields: [authorizationDecisions.authorizationSnapshotId],
      references: [authorizationSnapshots.id],
    }),
  }),
);

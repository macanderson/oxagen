// contracts/index.ts — canonical per-package contracts array.
//
// Every capability registered via registerCapability() in this package is re-exported here.
// The array is the canonical registry for tooling that needs to discover capabilities
// (seed migration, check-contracts.mjs CI guard, Wave 5 access UI). Adding a
// new contract file requires a corresponding entry here.
//
// Note: these imports trigger the registerCapability() side-effects inside
// each file, so this barrel also serves as the registration entrypoint.

import type { CapabilityDeclaration } from "../types";
import { apiKeyCreate } from "./api.key.create";
import { apiKeyRevoke } from "./api.key.revoke";
import { assetUpload } from "./asset.upload";
import { agentApprovalResolve } from "./agent.approval.resolve";
import { agentDefinitionCreate } from "./agent.definition.create";
import { agentDefinitionDelete } from "./agent.definition.delete";
import { agentDefinitionSuggest } from "./agent.definition.suggest";
import { agentDefinitionRevise } from "./agent.definition.revise";
import { agentDefinitionSummarize } from "./agent.definition.summarize";
import { agentDefinitionUpdate } from "./agent.definition.update";
import { agentDefinitionPublish } from "./agent.definition.publish";
import { agentDefinitionGet } from "./agent.definition.get";
import { agentDefinitionList } from "./agent.definition.list";
import { agentRoleAssign } from "./agent.role.assign";
import { agentRoleRevoke } from "./agent.role.revoke";
import { agentRoleList } from "./agent.role.list";
import { agentRoleGet } from "./agent.role.get";
import { agentDeploy } from "./agent.deploy";
import { agentExecutionList } from "./agent.execution.list";
import { modelCapabilityList } from "./model.capability.list";
import { agentExecutionRecord } from "./agent.execution.record";
import { agentTraceGet } from "./agent.trace.get";
import { agentDebugTrace } from "./agent.debug.trace";
import { telemetryErrorCluster } from "./telemetry.error.cluster";
import { telemetryStellaEnroll } from "./telemetry.stella.enroll";
import { telemetryStellaIngest } from "./telemetry.stella.ingest";
import { tachoEnrollmentCreate } from "./tacho.enrollment.create";
import { tachoEnrollmentRevoke } from "./tacho.enrollment.revoke";
import { tachoEventsIngest } from "./tacho.events.ingest";
import { tachoBundleGet } from "./tacho.bundle.get";
import { tachoCommandDispatch } from "./tacho.command.dispatch";
import { tachoCommandFetch } from "./tacho.command.fetch";
import { tachoHostList } from "./tacho.host.list";
import { tachoSessionList } from "./tacho.session.list";
import { tachoSessionGet } from "./tacho.session.get";
import { agentMcpList } from "./agent.mcp.list";
import { agentMcpResolve } from "./agent.mcp.resolve";
import { agentMcpRegister } from "./agent.mcp.register";
import { agentMcpSetEnabled } from "./agent.mcp.set_enabled";
import { agentMcpDelete } from "./agent.mcp.delete";
import { agentMcpConsentResolve } from "./agent.mcp_consent.resolve";
import { agentMcpConsentList } from "./agent.mcp_consent.list";
import { agentMemoryRecall } from "./agent.memory.recall";
import { agentMemoryWrite } from "./agent.memory.write";
import { agentMemoryList } from "./agent.memory.list";
import { agentMemoryUpdate } from "./agent.memory.update";
import { agentMemoryDelete } from "./agent.memory.delete";
import { agentMemoryRemember } from "./agent.memory.remember";
// Bulk memory import (parse → editable review grid → commit).
import { agentMemoryImportParse } from "./agent.memory_import.parse";
import { agentMemoryImportCommit } from "./agent.memory_import.commit";
// Two-axis memory: promotion (confidence ladder), citation/evidence mechanism.
import { agentMemoryPromote } from "./agent.memory.promote";
import { agentMemoryPromotionCandidates } from "./agent.memory_promotion.list";
import { agentMemoryCite } from "./agent.memory.cite";
import { agentMemoryEvidenceAttach } from "./agent.memory_evidence.attach";
import { agentMemoryCitationsList } from "./agent.memory_citation.list";
import { agentMemoryCitationStats } from "./agent.memory_citation.stats";
import { agentMemoryDemote } from "./agent.memory.demote";
import { agentMemoryPromotionDismiss } from "./agent.memory_promotion.dismiss";
import { agentMemoryPromotionRationales } from "./agent.memory_promotion.rationales";
import { agentToolList } from "./agent.tool.list";
import { billingCreditsPurchase } from "./billing.credits.purchase";
import { billingSubscriptionRead } from "./billing.subscription.read";
import { billingSubscriptionUpgradeStart } from "./billing.subscription_upgrade.start";
import { billingUsageBreakdown } from "./billing.usage.breakdown";
import { chatMessageExecution } from "./chat.message.execution";
import { chatMessageSend } from "./chat.message.send";
import { conversationArchive } from "./conversation.archive";
import { conversationDelete } from "./conversation.delete";
import { conversationList } from "./conversation.list";
import { conversationPurge } from "./conversation.purge";
import { conversationRename } from "./conversation.rename";
import { conversationFilesList } from "./conversation.files.list";
import { conversationExport } from "./conversation.export";
import { conversationAttachmentAdd } from "./conversation.attachment.add";
import { organizationCreate } from "./org.create";
import { orgMemberAdd } from "./org.member.add";
import { orgMemberInviteAccept } from "./org.member_invite.accept";
import { orgMemberInviteDecline } from "./org.member_invite.decline";
import { orgMemberRemove } from "./org.member.remove";
import { orgMemberRoleChange } from "./org.member_role.change";
import { orgList } from "./org.list";
import { workspaceCreate } from "./workspace.create";
import { workspaceList } from "./workspace.list";
import { systemInstallInstructions } from "./system.install.instructions";
import { userPreferencesRead } from "./user.preferences.read";
import { userPreferencesWrite } from "./user.preferences.write";
import { userWorkspacePreferencesRead } from "./user.workspace_preferences.read";
import { userWorkspacePreferencesWrite } from "./user.workspace_preferences.write";
import { budgetPolicyRead } from "./budget.policy.read";
import { budgetPolicyWrite } from "./budget.policy.write";
import { workspaceBudgetPolicyRead } from "./workspace.budget_policy.read";
import { workspaceBudgetPolicyWrite } from "./workspace.budget_policy.write";
import { billingBudgetGet } from "./billing.budget.get";
import { billingBudgetSet } from "./billing.budget.set";
import { workspaceModelSettingsRead } from "./workspace.model_settings.read";
import { workspaceModelSettingsWrite } from "./workspace.model_settings.write";
import { promptSettingsRead } from "./prompt.settings.read";
import { promptSettingsWrite } from "./prompt.settings.write";
import { notificationsList } from "./notification.list";
import { notificationsMark } from "./notification.mark";
import { pluginCatalogBrowse } from "./plugin.catalog.browse";
import { pluginCatalogGet } from "./plugin.catalog.get";
import { pluginCatalogSync } from "./plugin.catalog.sync";
import { pluginCredentialReauth } from "./plugin.credential.reauth";
import { pluginCredentialRevoke } from "./plugin.credential.revoke";
import { pluginCredentialSetSecret } from "./plugin.credential.set_secret";
import { pluginOrgInstall } from "./plugin.org.install";
import { pluginOrgInstallBulk } from "./plugin.org.install_bulk";
import { pluginOrgList } from "./plugin.org.list";
import { pluginSetEnabled } from "./plugin.set_enabled";
import { pluginOrgUninstall } from "./plugin.org.uninstall";
import { pluginRegistryAdd } from "./plugin.registry.add";
import { pluginRegistryList } from "./plugin.registry.list";
import { pluginRegistryRemove } from "./plugin.registry.remove";
import { pluginSettingsSetAuthAlerts } from "./plugin.settings.set_auth_alerts";
import { pluginSettingsGetAuthAlerts } from "./plugin.settings.get_auth_alerts";
import { capabilityRegistryList } from "./capability.registry.list";
import { capabilityRegistryGet } from "./capability.registry.get";
import { iamRoleList } from "./iam.role.list";
import { conversationChat } from "./conversation.chat";
import { workspaceMemberList } from "./workspace.member.list";
import { workspaceInviteSend } from "./workspace.invite.send";
import { toolDeclarationPublish } from "./tool.declaration.publish";
import { toolDeclarationList } from "./tool.declaration.list";
import { contextRecordPublish } from "./context.record.publish";
import { contextRecordList } from "./context.record.list";
import { contextRecordPromote } from "./context.record.promote";
import { connectionList } from "./connection.list";
import { connectionCreate } from "./connection.create";
import { connectionGet } from "./connection.get";
import { connectionDelete } from "./connection.delete";
import { connectionPreview } from "./connection.preview";
import { connectionMappingsSuggest } from "./connection.mappings.suggest";
import { connectionMappingsGet } from "./connection.mappings.get";
import { connectionMappingsSet } from "./connection.mappings.set";
import { privacyDataExport } from "./privacy.data.export";
import { privacyDataErase } from "./privacy.data.erase";
import { graphNodeLabelsGet } from "./graph.node_label.get";
import { knowledgeNodeRefSchema } from "./knowledge.node-ref";
import { graphNodeGet } from "./graph.node.get";
import { graphNodeSearch } from "./graph.node.search";
import { graphSearch } from "./graph.search";
import { pluginSchemaGet } from "./plugin.schema.get";
import { pluginSchemaValidate } from "./plugin.schema.validate";
import { pluginVersionList } from "./plugin.version.list";
import { repoBranchList } from "./repo.branch.list";
import { repoConfigure } from "./repo.configure";
import { repoPrGet } from "./repo.pr.get";
import { repoPrDiff } from "./repo.pr.diff";
import { repoCiStatus } from "./repo.ci.status";
import { repoSync } from "./repo.sync";
import { repoPause } from "./repo.pause";
import { repoResume } from "./repo.resume";
import { repoMetrics } from "./repo.metrics";
import { integrationInstall } from "./integration.install";
import { integrationConfigure } from "./integration.configure";
import { integrationList } from "./integration.list";
import { integrationGet } from "./integration.get";
import { integrationSync } from "./integration.sync";
import { integrationMetrics } from "./integration.metrics";
import { integrationDelete } from "./integration.delete";
import { graphNodeList } from "./graph.node.list";
import { graphStats } from "./graph.stats";
import { ontologyQuery } from "./ontology.query";
import { ontologyNeighbors } from "./ontology.neighbors";
import { apiKeyRotate } from "./api.key.rotate";
import { auditLogQuery } from "./audit.log.query";
import { connectionPause } from "./connection.pause";
import { connectionUpdate } from "./connection.update";
import { orgDataPlaneGet } from "./org.data_plane.get";
import { orgDataPlaneSet } from "./org.data_plane.set";
import { orgSettingsRead } from "./org.settings.read";
import { orgSettingsWrite } from "./org.settings.write";
import { workspaceSettingsRead } from "./workspace.settings.read";
import { workspaceSettingsWrite } from "./workspace.settings.write";
import { commandMenuSearch } from "./command.menu.search";
import { commandMenuSuggest } from "./command.menu.suggest";
import { referenceSearch } from "./reference.search";
import { referenceCite } from "./reference.cite";
import { schemaRegistryGet } from "./schema.registry.get";
import { schemaRegistryConfig } from "./schema.registry.config";
import { schemaList } from "./schema.list";
import { schemaToggle } from "./schema.toggle";
import { schemaLabelUpsert } from "./schema.label.upsert";
import { schemaLabelDelete } from "./schema.label.delete";
import { schemaRelationshipUpsert } from "./schema.relationship.upsert";
import { schemaRelationshipDelete } from "./schema.relationship.delete";
import { schemaPropertyUpsert } from "./schema.property.upsert";
import { schemaPropertyDelete } from "./schema.property.delete";
import { schemaVersionCreate } from "./schema.version.create";
import { schemaVersionPin } from "./schema.version.pin";
import { schemaVersionList } from "./schema.version.list";
import { schemaVersionDiff } from "./schema.version.diff";
import { schemaExport } from "./schema.export";
import { schemaRecommend } from "./schema.recommend";
import { schemaSetup } from "./schema.setup";
import { schemaChat } from "./schema.chat";
import { schemaDelete } from "./schema.delete";
import { schemaValidateNode } from "./schema.validate.node";
import { schemaValidateRelationship } from "./schema.validate.relationship";
import { schemaReconcileDispatch } from "./schema.reconcile.dispatch";
import { schemaReconcileStatus } from "./schema.reconcile.status";
// Environments + credential vault (Spec: 2026-06-24-credential-vault-…).
import { environmentCreate } from "./environment.create";
import { environmentList } from "./environment.list";
import { environmentGet } from "./environment.get";
import { environmentUpdate } from "./environment.update";
import { environmentDelete } from "./environment.delete";
import { environmentSetDefault } from "./environment.set_default";
import { agentEnvironmentBind } from "./agent.environment.bind";
import { agentEnvironmentUnbind } from "./agent.environment.unbind";
import { agentEnvironmentList } from "./agent.environment.list";
import { secretKeyUpsert } from "./secret.key.upsert";
import { secretKeyList } from "./secret.key.list";
import { secretKeyDelete } from "./secret.key.delete";
import { secretValueSet } from "./secret.value.set";
import { secretValueUnset } from "./secret.value.unset";
import { secretImportEnv } from "./secret.import_env";
import { secretReveal } from "./secret.reveal";
import { secretExport } from "./secret.export";
// Memory decay policies.
import { agentMemoryPolicyRead } from "./agent.memory_policy.read";
import { agentMemoryPolicyWrite } from "./agent.memory_policy.write";
import { routerPolicyGet } from "./router.policy.get";
import { routerPolicySet } from "./router.policy.set";
import { routerStatsList } from "./router.stats.list";
import { routerDecisionPreview } from "./router.decision.preview";

// Shared router.* schemas (not capabilities themselves) — re-exported so the
// contracts array guard sees router-schema.ts referenced, mirroring eval-schema.
export {
  routingModeSchema,
  routingPolicySourceSchema,
  routingPolicyScopeSchema,
  marketRouteSourceSchema,
  routingPolicySchema,
  routingStatRowSchema,
  marketCandidateSchema,
} from "./router-schema";

export type {
  FieldError as SharedFieldError,
  PropertyInput as SharedPropertyInput,
} from "./schema.shared";
export type { FieldError, DataType, PropertyInput } from "./schema.types";
// Memory policy schema + types. Capability objects are exported in
// the named block below; here we expose the shared schema and TS types.
export { memoryPolicySchema } from "./agent.memory_policy.read";
export type { AgentMemoryPolicyReadOutput } from "./agent.memory_policy.read";
export type {
  AgentMemoryPolicyWriteInput,
  AgentMemoryPolicyWriteOutput,
} from "./agent.memory_policy.write";
// Bulk memory import: shared draft schema/types + per-contract IO types. The
// shared file is not a capability, so it is exported here to satisfy the
// check-contracts file-coverage guard (same reason as schema.shared above).
export { memoryImportDraftSchema } from "./agent.memory_import.shared";
export type {
  MemoryImportDraft,
  MemoryImportDraftInput,
} from "./agent.memory_import.shared";
export type {
  AgentMemoryImportParseInput,
  AgentMemoryImportParseOutput,
} from "./agent.memory_import.parse";
export type {
  AgentMemoryImportCommitInput,
  AgentMemoryImportCommitOutput,
} from "./agent.memory_import.commit";
// Two-axis memory model — shared enums, record schema, and invariant helpers.
// Not a capability, so exported here to satisfy the file-coverage guard.
export {
  agentMemoryRecordSchema,
  memoryClassEnum,
  memoryKindSchema,
  memoryStatusEnum,
  actorKindEnum,
  influenceEnum,
  complianceEnum,
  evidenceSourceKindEnum,
  RECOMMENDED_MEMORY_KINDS,
  assertMemoryClassInvariants,
  deriveCompliance,
} from "./agent.memory.model";
export type {
  AgentMemoryRecord,
  MemoryClass,
  MemoryStatus,
  ActorKind,
  Influence,
  Compliance,
  EvidenceSourceKind,
} from "./agent.memory.model";
export type {
  AgentMemoryPromoteInput,
  AgentMemoryPromoteOutput,
} from "./agent.memory.promote";
export type {
  AgentMemoryPromotionCandidatesInput,
  AgentMemoryPromotionCandidatesOutput,
} from "./agent.memory_promotion.list";
export type {
  AgentMemoryCiteInput,
  AgentMemoryCiteOutput,
} from "./agent.memory.cite";
export type {
  AgentMemoryEvidenceAttachInput,
  AgentMemoryEvidenceAttachOutput,
} from "./agent.memory_evidence.attach";
export type {
  AgentMemoryCitationsListInput,
  AgentMemoryCitationsListOutput,
} from "./agent.memory_citation.list";

// Sandbox-template value objects + portable manifest v1 (shared schema module).

// ADR-042 data-plane wire schemas (not capabilities themselves) — re-exported
// so surfaces and the app import one canonical shape, and so the contracts
// guard sees this sibling module referenced.
export {
  dataPlaneKindSchema,
  dataPlaneModeSchema,
  dataPlaneStatusSchema,
  dataPlaneBindingSchema,
  dataPlaneConfigSchema,
  postgresPlaneConfigSchema,
  neo4jPlaneConfigSchema,
  clickhousePlaneConfigSchema,
} from "./org.data_plane.shared";
export type {
  DataPlaneKindValue,
  DataPlaneBindingDto,
  PostgresPlaneConfigInput,
  Neo4jPlaneConfigInput,
  ClickHousePlaneConfigInput,
} from "./org.data_plane.shared";

export {
  apiKeyCreate,
  apiKeyRevoke,
  assetUpload,
  agentApprovalResolve,
  agentDefinitionCreate,
  agentDefinitionDelete,
  agentDefinitionSuggest,
  agentDefinitionRevise,
  agentDefinitionSummarize,
  agentDefinitionUpdate,
  agentDefinitionPublish,
  agentDefinitionGet,
  agentDefinitionList,
  agentRoleAssign,
  agentRoleRevoke,
  agentRoleList,
  agentRoleGet,
  agentDeploy,
  agentExecutionList,
  agentExecutionRecord,
  modelCapabilityList,
  agentMcpList,
  agentMcpResolve,
  agentMcpRegister,
  agentMcpSetEnabled,
  agentMcpDelete,
  agentMcpConsentResolve,
  agentMcpConsentList,
  agentMemoryRecall,
  agentMemoryWrite,
  agentMemoryList,
  agentMemoryUpdate,
  agentMemoryDelete,
  agentMemoryRemember,
  agentMemoryImportParse,
  agentMemoryImportCommit,
  agentMemoryPromote,
  agentMemoryPromotionCandidates,
  agentMemoryCite,
  agentMemoryEvidenceAttach,
  agentMemoryCitationsList,
  agentMemoryCitationStats,
  agentMemoryDemote,
  agentMemoryPromotionDismiss,
  agentMemoryPromotionRationales,
  agentTraceGet,
  agentDebugTrace,
  telemetryErrorCluster,
  telemetryStellaEnroll,
  telemetryStellaIngest,
  tachoEnrollmentCreate,
  tachoEnrollmentRevoke,
  tachoEventsIngest,
  tachoBundleGet,
  tachoCommandDispatch,
  tachoCommandFetch,
  tachoHostList,
  tachoSessionList,
  tachoSessionGet,
  agentToolList,
  billingCreditsPurchase,
  billingSubscriptionRead,
  billingSubscriptionUpgradeStart,
  billingUsageBreakdown,
  chatMessageExecution,
  chatMessageSend,
  conversationArchive,
  conversationDelete,
  conversationList,
  conversationPurge,
  conversationRename,
  conversationFilesList,
  conversationExport,
  conversationAttachmentAdd,
  organizationCreate,
  orgList,
  orgMemberAdd,
  orgMemberInviteAccept,
  orgMemberInviteDecline,
  orgMemberRemove,
  orgMemberRoleChange,
  workspaceCreate,
  workspaceList,
  systemInstallInstructions,
  userPreferencesRead,
  userPreferencesWrite,
  userWorkspacePreferencesRead,
  userWorkspacePreferencesWrite,
  budgetPolicyRead,
  budgetPolicyWrite,
  billingBudgetGet,
  billingBudgetSet,
  workspaceBudgetPolicyRead,
  workspaceBudgetPolicyWrite,
  workspaceModelSettingsRead,
  workspaceModelSettingsWrite,
  promptSettingsRead,
  promptSettingsWrite,
  notificationsList,
  notificationsMark,
  pluginCatalogBrowse,
  pluginCatalogGet,
  pluginCatalogSync,
  pluginCredentialReauth,
  pluginCredentialRevoke,
  pluginCredentialSetSecret,
  pluginOrgInstall,
  pluginOrgInstallBulk,
  pluginOrgList,
  pluginSetEnabled,
  pluginOrgUninstall,
  pluginRegistryAdd,
  pluginRegistryList,
  pluginRegistryRemove,
  pluginSettingsSetAuthAlerts,
  pluginSettingsGetAuthAlerts,
  capabilityRegistryList,
  capabilityRegistryGet,
  iamRoleList,
  conversationChat,
  workspaceMemberList,
  workspaceInviteSend,
  toolDeclarationPublish,
  toolDeclarationList,
  contextRecordPublish,
  contextRecordList,
  contextRecordPromote,
  connectionList,
  connectionCreate,
  connectionGet,
  connectionDelete,
  connectionPreview,
  connectionMappingsSuggest,
  connectionMappingsGet,
  connectionMappingsSet,
  privacyDataExport,
  privacyDataErase,
  graphNodeLabelsGet,
  knowledgeNodeRefSchema,
  graphNodeGet,
  graphNodeSearch,
  graphSearch,
  pluginSchemaGet,
  pluginSchemaValidate,
  pluginVersionList,
  repoBranchList,
  repoConfigure,
  repoPrGet,
  repoPrDiff,
  repoCiStatus,
  repoSync,
  repoPause,
  repoResume,
  repoMetrics,
  integrationInstall,
  integrationConfigure,
  integrationList,
  integrationGet,
  integrationSync,
  integrationMetrics,
  integrationDelete,
  graphNodeList,
  graphStats,
  ontologyQuery,
  ontologyNeighbors,
  apiKeyRotate,
  auditLogQuery,
  connectionPause,
  connectionUpdate,
  orgDataPlaneGet,
  orgDataPlaneSet,
  orgSettingsRead,
  orgSettingsWrite,
  workspaceSettingsRead,
  workspaceSettingsWrite,
  commandMenuSearch,
  commandMenuSuggest,
  referenceSearch,
  referenceCite,
  schemaRegistryGet,
  schemaRegistryConfig,
  schemaList,
  schemaToggle,
  schemaLabelUpsert,
  schemaLabelDelete,
  schemaRelationshipUpsert,
  schemaRelationshipDelete,
  schemaPropertyUpsert,
  schemaPropertyDelete,
  schemaVersionCreate,
  schemaVersionPin,
  schemaVersionList,
  schemaVersionDiff,
  schemaExport,
  schemaRecommend,
  schemaSetup,
  schemaChat,
  schemaDelete,
  schemaValidateNode,
  schemaValidateRelationship,
  schemaReconcileDispatch,
  schemaReconcileStatus,
  environmentCreate,
  environmentList,
  environmentGet,
  environmentUpdate,
  environmentDelete,
  environmentSetDefault,
  agentEnvironmentBind,
  agentEnvironmentUnbind,
  agentEnvironmentList,
  secretKeyUpsert,
  secretKeyList,
  secretKeyDelete,
  secretValueSet,
  secretValueUnset,
  secretImportEnv,
  secretReveal,
  secretExport,
  agentMemoryPolicyRead,
  agentMemoryPolicyWrite,
  routerPolicyGet,
  routerPolicySet,
  routerStatsList,
  routerDecisionPreview,
};

/**
 * The canonical contracts array for this package. Used by:
 *   - tools/scripts/check-contracts.mjs (CI guard)
 *   - tools/scripts/seed-iam-defaults.ts (seed migration)
 *   - Wave 5 access matrix UI
 *
 * Add one entry here whenever a new contract file is added to this directory.
 */
// Annotated wide on purpose: the inferred tuple type of ~350 contracts exceeds
// what the compiler will serialize into a declaration file.
export const contracts: readonly CapabilityDeclaration[] = [
  apiKeyCreate,
  apiKeyRevoke,
  assetUpload,
  agentApprovalResolve,
  agentDefinitionCreate,
  agentDefinitionDelete,
  agentDefinitionSuggest,
  agentDefinitionRevise,
  agentDefinitionSummarize,
  agentDefinitionUpdate,
  agentDefinitionPublish,
  agentDefinitionGet,
  agentDefinitionList,
  agentRoleAssign,
  agentRoleRevoke,
  agentRoleList,
  agentRoleGet,
  agentDeploy,
  agentMcpList,
  agentMcpResolve,
  agentMcpRegister,
  agentMcpSetEnabled,
  agentMcpDelete,
  agentMcpConsentResolve,
  agentMcpConsentList,
  agentMemoryRecall,
  agentMemoryWrite,
  agentMemoryList,
  agentMemoryUpdate,
  agentMemoryDelete,
  agentMemoryRemember,
  agentMemoryImportParse,
  agentMemoryImportCommit,
  agentMemoryPromote,
  agentMemoryPromotionCandidates,
  agentMemoryCite,
  agentMemoryEvidenceAttach,
  agentMemoryCitationsList,
  agentMemoryCitationStats,
  agentMemoryDemote,
  agentMemoryPromotionDismiss,
  agentMemoryPromotionRationales,
  agentTraceGet,
  agentDebugTrace,
  telemetryErrorCluster,
  telemetryStellaEnroll,
  telemetryStellaIngest,
  tachoEnrollmentCreate,
  tachoEnrollmentRevoke,
  tachoEventsIngest,
  tachoBundleGet,
  tachoCommandDispatch,
  tachoCommandFetch,
  tachoHostList,
  tachoSessionList,
  tachoSessionGet,
  agentToolList,
  billingCreditsPurchase,
  billingSubscriptionRead,
  billingSubscriptionUpgradeStart,
  billingUsageBreakdown,
  chatMessageExecution,
  chatMessageSend,
  conversationArchive,
  conversationDelete,
  conversationList,
  conversationPurge,
  conversationRename,
  conversationFilesList,
  conversationExport,
  conversationAttachmentAdd,
  organizationCreate,
  orgList,
  orgMemberAdd,
  orgMemberInviteAccept,
  orgMemberInviteDecline,
  orgMemberRemove,
  orgMemberRoleChange,
  workspaceCreate,
  workspaceList,
  systemInstallInstructions,
  userPreferencesRead,
  userPreferencesWrite,
  userWorkspacePreferencesRead,
  userWorkspacePreferencesWrite,
  budgetPolicyRead,
  budgetPolicyWrite,
  billingBudgetGet,
  billingBudgetSet,
  workspaceBudgetPolicyRead,
  workspaceBudgetPolicyWrite,
  workspaceModelSettingsRead,
  workspaceModelSettingsWrite,
  promptSettingsRead,
  promptSettingsWrite,
  notificationsList,
  notificationsMark,
  pluginCatalogBrowse,
  pluginCatalogGet,
  pluginCatalogSync,
  pluginCredentialReauth,
  pluginCredentialRevoke,
  pluginCredentialSetSecret,
  pluginOrgInstall,
  pluginOrgInstallBulk,
  pluginOrgList,
  pluginSetEnabled,
  pluginOrgUninstall,
  pluginRegistryAdd,
  pluginRegistryList,
  pluginRegistryRemove,
  pluginSettingsSetAuthAlerts,
  pluginSettingsGetAuthAlerts,
  capabilityRegistryList,
  capabilityRegistryGet,
  iamRoleList,
  conversationChat,
  workspaceMemberList,
  workspaceInviteSend,
  toolDeclarationPublish,
  toolDeclarationList,
  contextRecordPublish,
  contextRecordList,
  contextRecordPromote,
  agentExecutionList,
  agentExecutionRecord,
  modelCapabilityList,
  connectionList,
  connectionCreate,
  connectionGet,
  connectionDelete,
  connectionPreview,
  connectionMappingsSuggest,
  connectionMappingsGet,
  connectionMappingsSet,
  privacyDataExport,
  privacyDataErase,
  graphNodeLabelsGet,
  graphNodeGet,
  graphNodeSearch,
  graphSearch,
  pluginSchemaGet,
  pluginSchemaValidate,
  pluginVersionList,
  repoBranchList,
  repoConfigure,
  repoPrGet,
  repoPrDiff,
  repoCiStatus,
  repoSync,
  repoPause,
  repoResume,
  repoMetrics,
  integrationInstall,
  integrationConfigure,
  integrationList,
  integrationGet,
  integrationSync,
  integrationMetrics,
  integrationDelete,
  graphNodeList,
  graphStats,
  ontologyQuery,
  ontologyNeighbors,
  apiKeyRotate,
  auditLogQuery,
  connectionPause,
  connectionUpdate,
  orgDataPlaneGet,
  orgDataPlaneSet,
  orgSettingsRead,
  orgSettingsWrite,
  workspaceSettingsRead,
  workspaceSettingsWrite,
  commandMenuSearch,
  commandMenuSuggest,
  referenceSearch,
  referenceCite,
  schemaRegistryGet,
  schemaRegistryConfig,
  schemaList,
  schemaToggle,
  schemaLabelUpsert,
  schemaLabelDelete,
  schemaRelationshipUpsert,
  schemaRelationshipDelete,
  schemaPropertyUpsert,
  schemaPropertyDelete,
  schemaVersionCreate,
  schemaVersionPin,
  schemaVersionList,
  schemaVersionDiff,
  schemaExport,
  schemaRecommend,
  schemaSetup,
  schemaChat,
  schemaDelete,
  schemaValidateNode,
  schemaValidateRelationship,
  schemaReconcileDispatch,
  schemaReconcileStatus,
  environmentCreate,
  environmentList,
  environmentGet,
  environmentUpdate,
  environmentDelete,
  environmentSetDefault,
  agentEnvironmentBind,
  agentEnvironmentUnbind,
  agentEnvironmentList,
  secretKeyUpsert,
  secretKeyList,
  secretKeyDelete,
  secretValueSet,
  secretValueUnset,
  secretImportEnv,
  secretReveal,
  secretExport,
  agentMemoryPolicyRead,
  agentMemoryPolicyWrite,
  routerPolicyGet,
  routerPolicySet,
  routerStatsList,
  routerDecisionPreview,
] as const;

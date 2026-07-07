// contracts/index.ts — canonical per-package contracts array (OXA-1390, Phase 3).
//
// Every capability registered via registerCapability() in this package is re-exported here.
// The array is the canonical registry for tooling that needs to discover capabilities
// (seed migration, check-contracts.mjs CI guard, Wave 5 access UI). Adding a
// new contract file requires a corresponding entry here.
//
// Note: these imports trigger the registerCapability() side-effects inside
// each file, so this barrel also serves as the registration entrypoint.

import { apiKeyCreate } from "./api.key.create";
import { apiKeyRevoke } from "./api.key.revoke";
import { archiveCreate } from "./archive.create";
import { assetUpload } from "./asset.upload";
import { agentApprovalResolve } from "./agent.approval.resolve";
import { agentCodeExecute } from "./agent.code.execute";
import { agentSandboxStart } from "./agent.sandbox.start";
import { agentSandboxExec } from "./agent.sandbox.exec";
import { agentSandboxSnapshot } from "./agent.sandbox.snapshot";
import { agentSandboxStop } from "./agent.sandbox.stop";
import { agentSandboxFilesList } from "./agent.sandbox_file.list";
import { browserNavigate } from "./browser.navigate";
import { browserScreenshot } from "./browser.screenshot";
import { browserFill } from "./browser.fill";
import { browserSubmit } from "./browser.submit";
import { browserClick } from "./browser.click";
import { browserRefresh } from "./browser.refresh";
import { browserRead } from "./browser.read";
import { agentFeatureVerify } from "./agent.feature.verify";
import { codeDiff } from "./code.diff";
import { codePatch } from "./code.patch";
import { codeFormat } from "./code.format";
import { codeMap } from "./code.map";
import { agentDefinitionCreate } from "./agent.definition.create";
import { agentDefinitionUpdate } from "./agent.definition.update";
import { agentDefinitionPublish } from "./agent.definition.publish";
import { agentDefinitionGet } from "./agent.definition.get";
import { agentDefinitionList } from "./agent.definition.list";
import { a2aCardGet } from "./a2a.card.get";
import { agentDeploy } from "./agent.deploy";
import { agentTriggerCreate } from "./agent.trigger.create";
import { agentTriggerUpdate } from "./agent.trigger.update";
import { agentTriggerDelete } from "./agent.trigger.delete";
import { agentTriggerList } from "./agent.trigger.list";
import { agentExecutionList } from "./agent.execution.list";
import { agentExecutionRecord } from "./agent.execution.record";
import { agentExecutionLineage } from "./agent.execution.lineage";
import { agentTraceGet } from "./agent.trace.get";
import { agentDebugTrace } from "./agent.debug.trace";
import { telemetryErrorCluster } from "./telemetry.error.cluster";
import { agentUiRender } from "./agent.ui.render";
import { documentsGenerate } from "./document.generate";
import { documentsPdfCreate } from "./document.pdf.create";
import { markdownGenerate } from "./markdown.generate";
import { mermaidGenerate } from "./mermaid.generate";
import { agentMcpList } from "./agent.mcp.list";
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
import { agentPlanApprove } from "./agent.plan.approve";
import { agentPlanCreate } from "./agent.plan.create";
import { agentFileLockAcquire } from "./agent.file_lock.acquire";
import { agentFileLockRelease } from "./agent.file_lock.release";
import { agentFileLockList } from "./agent.file_lock.list";
import { agentSkillList } from "./agent.skill.list";
import { agentSkillLoad } from "./agent.skill.load";
import { agentSubagentFanoutGet } from "./agent.subagent_fanout.get";
import { agentSubagentResultGet } from "./agent.subagent_result.get";
import { agentSubagentSiblings } from "./agent.subagent.siblings";
import { agentSubagentFanoutList } from "./agent.subagent_fanout.list";
import { agentTaskBackgroundCancel } from "./agent.background_task.cancel";
import { agentTaskBackgroundRead } from "./agent.background_task.read";
import { agentTaskBackgroundStart } from "./agent.background_task.start";
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
import { conversationAttachmentAdd } from "./conversation.attachment.add";
import { formFill } from "./form.fill";
import { organizationCreate } from "./org.create";
import { orgMemberAdd } from "./org.member.add";
import { orgMemberInviteAccept } from "./org.member_invite.accept";
import { orgMemberInviteDecline } from "./org.member_invite.decline";
import { orgMemberRemove } from "./org.member.remove";
import { orgMemberRoleChange } from "./org.member_role.change";
import { orgList } from "./org.list";
import { workspaceCreate } from "./workspace.create";
import { workspaceList } from "./workspace.list";
import { videoGenerate } from "./video.generate";
import { imageGenerate } from "./image.generate";
import { svgGenerate } from "./svg.generate";
import { systemInstallInstructions } from "./system.install.instructions";
import { userPreferencesRead } from "./user.preferences.read";
import { userPreferencesWrite } from "./user.preferences.write";
import { budgetPolicyRead } from "./budget.policy.read";
import { budgetPolicyWrite } from "./budget.policy.write";
import { workspaceBudgetPolicyRead } from "./workspace.budget_policy.read";
import { workspaceBudgetPolicyWrite } from "./workspace.budget_policy.write";
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
import { pluginCredentialSetSecret } from "./plugin.credential.set_secret";
import { pluginOrgInstall } from "./plugin.org.install";
import { pluginOrgInstallBulk } from "./plugin.org.install_bulk";
import { pluginOrgList } from "./plugin.org.list";
import { pluginOrgSetEnabled } from "./plugin.org.set_enabled";
import { pluginOrgUninstall } from "./plugin.org.uninstall";
import { pluginRegistryAdd } from "./plugin.registry.add";
import { pluginRegistryList } from "./plugin.registry.list";
import { pluginRegistryRemove } from "./plugin.registry.remove";
import { pluginSettingsSetAuthAlerts } from "./plugin.settings.set_auth_alerts";
import { pluginWorkspaceSetEnabled } from "./plugin.workspace.set_enabled";
import { workflowRun } from "./workflow.run";
import { workflowStatus } from "./workflow.status";
import { workflowCancel } from "./workflow.cancel";
import { conversationChat } from "./conversation.chat";
import { imageCreate } from "./image.create";
import { imageList } from "./image.list";
import { imageAnalyze } from "./image.analyze";
import { documentCreate } from "./document.create";
import { documentList } from "./document.list";
import { documentRead } from "./document.read";
import { automationList } from "./automation.list";
import { automationCreate } from "./automation.create";
import { automationTrigger } from "./automation.trigger";
import { automationEnable } from "./automation.enable";
import { automationDisable } from "./automation.disable";
import { workspaceMemberList } from "./workspace.member.list";
import { workspaceInviteSend } from "./workspace.invite.send";
import { skillWorkspaceList } from "./skill.workspace.list";
import { skillWorkspaceInstall } from "./skill.workspace.install";
import { skillVersionList } from "./skill.version.list";
import { skillVersionGet } from "./skill.version.get";
import { skillVersionUpload } from "./skill.version.upload";
import { skillVersionActivate } from "./skill.version.activate";
import { skillEdit } from "./skill.edit";
import { skillExport } from "./skill.export";
import { skillMetricsRead } from "./skill.metrics.read";
import { skillCreate } from "./skill.create";
import { skillEnable } from "./skill.enable";
import { agentSubagentAggregate } from "./agent.subagent.aggregate";
import { agentSubagentDispatch } from "./agent.subagent.dispatch";
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
import { researchSwarmStart } from "./research.swarm.start";
import { researchSwarmStatus } from "./research.swarm.status";
import { graphNodeUpsert } from "./graph.node.upsert";
import { graphNodeLabelAdd } from "./graph.node_label.add";
import { graphNodeLabelRemove } from "./graph.node_label.remove";
import { graphNodeLabelsGet } from "./graph.node_label.get";
import { graphNodeGet } from "./graph.node.get";
import { graphNodeDelete } from "./graph.node.delete";
import { graphNodeSearch } from "./graph.node.search";
import { graphSearch } from "./graph.search";
import { graphExport } from "./graph.export";
import { graphEdgeUpsert } from "./graph.edge.upsert";
import { graphEdgeDelete } from "./graph.edge.delete";
import { graphCypher } from "./graph.cypher";
import { webSearch } from "./web.search";
import { webFetch } from "./web.fetch";
import { semanticEdgeApprove } from "./semantic.edge.approve";
import { semanticEdgeInfer } from "./semantic.edge.infer";
import { semanticEdgeList } from "./semantic.edge.list";
import { semanticEdgeSuggest } from "./semantic.edge.suggest";
import { pluginSchemaGet } from "./plugin.schema.get";
import { pluginSchemaValidate } from "./plugin.schema.validate";
import { pluginVersionList } from "./plugin.version.list";
import { repoBranchCreate } from "./repo.branch.create";
import { repoConfigure } from "./repo.configure";
import { repoCreate } from "./repo.create";
import { repoFilePut } from "./repo.file.put";
import { repoFork } from "./repo.fork";
import { repoPrOpen } from "./repo.pr.open";
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
import { agentRepoEdit } from "./agent.repo.edit";
import { agentCompose } from "./agent.compose";
import { agentSubagentCancel } from "./agent.subagent.cancel";
import { agentSubagentLogs } from "./agent.subagent.logs";
import { apiKeyRotate } from "./api.key.rotate";
import { auditLogQuery } from "./audit.log.query";
import { automationUpdate } from "./automation.update";
import { connectionPause } from "./connection.pause";
import { connectionUpdate } from "./connection.update";
import { graphIngest } from "./graph.ingest";
import { graphSyncPush } from "./graph.sync.push";
import { orgSettingsRead } from "./org.settings.read";
import { orgSettingsWrite } from "./org.settings.write";
import { workspaceSettingsRead } from "./workspace.settings.read";
import { workspaceSettingsWrite } from "./workspace.settings.write";
import { commandMenuSearch } from "./command.menu.search";
import { commandMenuSuggest } from "./command.menu.suggest";
import { skillAuthor } from "./skill.author";
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
import { graphRelationshipUpsert } from "./graph.relationship.upsert";
import { semanticRelationshipApprove } from "./semantic.relationship.approve";
import { semanticRelationshipInfer } from "./semantic.relationship.infer";
import { semanticRelationshipList } from "./semantic.relationship.list";
import { semanticRelationshipSuggest } from "./semantic.relationship.suggest";
// Environments + credential vault (Spec: 2026-06-24-credential-vault-…).
import { environmentCreate } from "./environment.create";
import { environmentList } from "./environment.list";
import { environmentGet } from "./environment.get";
import { environmentUpdate } from "./environment.update";
import { environmentDelete } from "./environment.delete";
import { environmentSetDefault } from "./environment.set_default";
import { secretKeyUpsert } from "./secret.key.upsert";
import { secretKeyList } from "./secret.key.list";
import { secretKeyDelete } from "./secret.key.delete";
import { secretValueSet } from "./secret.value.set";
import { secretValueUnset } from "./secret.value.unset";
import { secretImportEnv } from "./secret.import_env";
import { secretReveal } from "./secret.reveal";
import { secretExport } from "./secret.export";
// Memory decay policies (OXA-1374).
import { agentMemoryPolicyRead } from "./agent.memory_policy.read";
import { agentMemoryPolicyWrite } from "./agent.memory_policy.write";
import { evalDatasetCreate } from "./eval.dataset.create";
import { evalDatasetList } from "./eval.dataset.list";
import { evalDatasetGet } from "./eval.dataset.get";
import { evalDatasetItemAdd } from "./eval.dataset_item.add";
import { evalDatasetFromTraces } from "./eval.dataset.from_traces";
import { evalRunStart } from "./eval.run.start";
import { evalRunStatus } from "./eval.run.status";
import { evalRunGet } from "./eval.run.get";

// Shared eval.* schemas (not capabilities themselves) — re-exported so the
// contracts array guard sees eval-schema.ts referenced, mirroring agent-schema.
export {
  evalDatasetItemSchema,
  evalTargetSchema,
  evalJudgeScoreSchema,
  evalRunStatusSchema,
} from "./eval-schema";
export type {
  EvalDatasetItem,
  EvalTarget,
  EvalJudgeScore,
  EvalRunStatus,
} from "./eval-schema";
// Re-export shared Zod helpers used across schema.* contracts.
// These are not capability contracts themselves but must appear here to satisfy
// the check-contracts file-coverage guard (tools/scripts/check-contracts.mjs).
export type {
  FieldError as SharedFieldError,
  PropertyInput as SharedPropertyInput,
} from "./schema.shared";
export type { FieldError, DataType, PropertyInput } from "./schema.types";
// Memory policy schema + types (OXA-1374). Capability objects are exported in
// the named block below; here we expose the shared schema and TS types.
export { memoryPolicySchema } from "./agent.memory_policy.read";
export type { AgentMemoryPolicyReadOutput } from "./agent.memory_policy.read";
export type { AgentMemoryPolicyWriteInput, AgentMemoryPolicyWriteOutput } from "./agent.memory_policy.write";
// Bulk memory import: shared draft schema/types + per-contract IO types. The
// shared file is not a capability, so it is exported here to satisfy the
// check-contracts file-coverage guard (same reason as schema.shared above).
export { memoryImportDraftSchema } from "./agent.memory_import.shared";
export type { MemoryImportDraft, MemoryImportDraftInput } from "./agent.memory_import.shared";
export type { AgentMemoryImportParseInput, AgentMemoryImportParseOutput } from "./agent.memory_import.parse";
export type { AgentMemoryImportCommitInput, AgentMemoryImportCommitOutput } from "./agent.memory_import.commit";
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
export type { AgentMemoryPromoteInput, AgentMemoryPromoteOutput } from "./agent.memory.promote";
export type {
  AgentMemoryPromotionCandidatesInput,
  AgentMemoryPromotionCandidatesOutput,
} from "./agent.memory_promotion.list";
export type { AgentMemoryCiteInput, AgentMemoryCiteOutput } from "./agent.memory.cite";
export type {
  AgentMemoryEvidenceAttachInput,
  AgentMemoryEvidenceAttachOutput,
} from "./agent.memory_evidence.attach";
export type {
  AgentMemoryCitationsListInput,
  AgentMemoryCitationsListOutput,
} from "./agent.memory_citation.list";

export {
  apiKeyCreate,
  apiKeyRevoke,
  archiveCreate,
  assetUpload,
  agentApprovalResolve,
  agentCodeExecute,
  agentSandboxStart,
  agentSandboxExec,
  agentSandboxSnapshot,
  agentSandboxStop,
  agentSandboxFilesList,
  browserNavigate,
  browserScreenshot,
  browserFill,
  browserSubmit,
  browserClick,
  browserRefresh,
  browserRead,
  agentFeatureVerify,
  codeDiff,
  codePatch,
  codeFormat,
  codeMap,
  agentDefinitionCreate,
  agentDefinitionUpdate,
  agentDefinitionPublish,
  agentDefinitionGet,
  agentDefinitionList,
  agentDeploy,
  agentTriggerCreate,
  agentTriggerUpdate,
  agentTriggerDelete,
  agentTriggerList,
  agentExecutionList,
  agentExecutionRecord,
  agentUiRender,
  documentsGenerate,
  documentsPdfCreate,
  markdownGenerate,
  mermaidGenerate,
  agentMcpList,
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
  agentPlanApprove,
  agentPlanCreate,
  agentFileLockAcquire,
  agentFileLockRelease,
  agentFileLockList,
  agentSkillList,
  agentSkillLoad,
  agentSubagentFanoutGet,
  agentSubagentFanoutList,
  agentSubagentResultGet,
  agentSubagentSiblings,
  agentTraceGet,
  agentDebugTrace,
  telemetryErrorCluster,
  agentExecutionLineage,
  agentTaskBackgroundCancel,
  agentTaskBackgroundRead,
  agentTaskBackgroundStart,
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
  conversationAttachmentAdd,
  formFill,
  organizationCreate,
  orgList,
  orgMemberAdd,
  orgMemberInviteAccept,
  orgMemberInviteDecline,
  orgMemberRemove,
  orgMemberRoleChange,
  workspaceCreate,
  workspaceList,
  videoGenerate,
  imageGenerate,
  svgGenerate,
  systemInstallInstructions,
  userPreferencesRead,
  userPreferencesWrite,
  budgetPolicyRead,
  budgetPolicyWrite,
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
  pluginCredentialSetSecret,
  pluginOrgInstall,
  pluginOrgInstallBulk,
  pluginOrgList,
  pluginOrgSetEnabled,
  pluginOrgUninstall,
  pluginRegistryAdd,
  pluginRegistryList,
  pluginRegistryRemove,
  pluginSettingsSetAuthAlerts,
  pluginWorkspaceSetEnabled,
  workflowRun,
  workflowStatus,
  workflowCancel,
  conversationChat,
  imageCreate,
  imageList,
  imageAnalyze,
  documentCreate,
  documentList,
  documentRead,
  automationList,
  automationCreate,
  automationTrigger,
  automationEnable,
  automationDisable,
  workspaceMemberList,
  workspaceInviteSend,
  skillWorkspaceList,
  skillWorkspaceInstall,
  skillVersionList,
  skillVersionGet,
  skillVersionUpload,
  skillVersionActivate,
  skillEdit,
  skillExport,
  skillMetricsRead,
  skillCreate,
  skillEnable,
  agentSubagentAggregate,
  agentSubagentDispatch,
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
  researchSwarmStart,
  researchSwarmStatus,
  graphNodeUpsert,
  graphNodeLabelAdd,
  graphNodeLabelRemove,
  graphNodeLabelsGet,
  graphNodeGet,
  graphNodeDelete,
  graphNodeSearch,
  graphSearch,
  graphExport,
  graphEdgeUpsert,
  graphEdgeDelete,
  graphCypher,
  webSearch,
  webFetch,
  semanticEdgeApprove,
  semanticEdgeInfer,
  semanticEdgeList,
  semanticEdgeSuggest,
  pluginSchemaGet,
  pluginSchemaValidate,
  pluginVersionList,
  repoBranchCreate,
  repoConfigure,
  repoCreate,
  repoFilePut,
  repoFork,
  repoPrOpen,
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
  agentRepoEdit,
  agentCompose,
  agentSubagentCancel,
  agentSubagentLogs,
  apiKeyRotate,
  auditLogQuery,
  automationUpdate,
  connectionPause,
  connectionUpdate,
  graphIngest,
  graphSyncPush,
  orgSettingsRead,
  orgSettingsWrite,
  workspaceSettingsRead,
  workspaceSettingsWrite,
  commandMenuSearch,
  commandMenuSuggest,
  skillAuthor,
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
  graphRelationshipUpsert,
  semanticRelationshipApprove,
  semanticRelationshipInfer,
  semanticRelationshipList,
  semanticRelationshipSuggest,
  environmentCreate,
  environmentList,
  environmentGet,
  environmentUpdate,
  environmentDelete,
  environmentSetDefault,
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
  evalDatasetCreate,
  evalDatasetList,
  evalDatasetGet,
  evalDatasetItemAdd,
  evalDatasetFromTraces,
  evalRunStart,
  evalRunStatus,
  evalRunGet,
};

/**
 * The canonical contracts array for this package. Used by:
 *   - tools/scripts/check-contracts.mjs (CI guard)
 *   - tools/scripts/seed-iam-defaults.ts (seed migration)
 *   - Wave 5 access matrix UI
 *
 * Add one entry here whenever a new contract file is added to this directory.
 */
export const contracts = [
  apiKeyCreate,
  apiKeyRevoke,
  archiveCreate,
  assetUpload,
  agentApprovalResolve,
  agentCodeExecute,
  agentSandboxStart,
  agentSandboxExec,
  agentSandboxSnapshot,
  agentSandboxStop,
  agentSandboxFilesList,
  browserNavigate,
  browserScreenshot,
  browserFill,
  browserSubmit,
  browserClick,
  browserRefresh,
  browserRead,
  agentFeatureVerify,
  codeDiff,
  codePatch,
  codeFormat,
  codeMap,
  agentDefinitionCreate,
  agentDefinitionUpdate,
  agentDefinitionPublish,
  agentDefinitionGet,
  agentDefinitionList,
  agentDeploy,
  agentTriggerCreate,
  agentTriggerUpdate,
  agentTriggerDelete,
  agentTriggerList,
  agentUiRender,
  documentsGenerate,
  documentsPdfCreate,
  markdownGenerate,
  mermaidGenerate,
  agentMcpList,
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
  agentPlanApprove,
  agentPlanCreate,
  agentFileLockAcquire,
  agentFileLockRelease,
  agentFileLockList,
  agentSkillList,
  agentSkillLoad,
  agentSubagentFanoutGet,
  agentSubagentFanoutList,
  agentSubagentResultGet,
  agentSubagentSiblings,
  agentTraceGet,
  agentDebugTrace,
  telemetryErrorCluster,
  agentExecutionLineage,
  agentTaskBackgroundCancel,
  agentTaskBackgroundRead,
  agentTaskBackgroundStart,
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
  conversationAttachmentAdd,
  formFill,
  organizationCreate,
  orgList,
  orgMemberAdd,
  orgMemberInviteAccept,
  orgMemberInviteDecline,
  orgMemberRemove,
  orgMemberRoleChange,
  workspaceCreate,
  workspaceList,
  videoGenerate,
  imageGenerate,
  svgGenerate,
  systemInstallInstructions,
  userPreferencesRead,
  userPreferencesWrite,
  budgetPolicyRead,
  budgetPolicyWrite,
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
  pluginCredentialSetSecret,
  pluginOrgInstall,
  pluginOrgInstallBulk,
  pluginOrgList,
  pluginOrgSetEnabled,
  pluginOrgUninstall,
  pluginRegistryAdd,
  pluginRegistryList,
  pluginRegistryRemove,
  pluginSettingsSetAuthAlerts,
  pluginWorkspaceSetEnabled,
  workflowRun,
  workflowStatus,
  workflowCancel,
  conversationChat,
  imageCreate,
  imageList,
  imageAnalyze,
  documentCreate,
  documentList,
  documentRead,
  automationList,
  automationCreate,
  automationTrigger,
  automationEnable,
  automationDisable,
  workspaceMemberList,
  workspaceInviteSend,
  skillWorkspaceList,
  skillWorkspaceInstall,
  skillVersionList,
  skillVersionGet,
  skillVersionUpload,
  skillVersionActivate,
  skillEdit,
  skillExport,
  skillMetricsRead,
  skillCreate,
  skillEnable,
  agentExecutionList,
  agentExecutionRecord,
  agentSubagentAggregate,
  agentSubagentDispatch,
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
  researchSwarmStart,
  researchSwarmStatus,
  graphNodeUpsert,
  graphNodeLabelAdd,
  graphNodeLabelRemove,
  graphNodeLabelsGet,
  graphNodeGet,
  graphNodeDelete,
  graphNodeSearch,
  graphSearch,
  graphExport,
  graphEdgeUpsert,
  graphEdgeDelete,
  graphCypher,
  webSearch,
  webFetch,
  semanticEdgeApprove,
  semanticEdgeInfer,
  semanticEdgeList,
  semanticEdgeSuggest,
  pluginSchemaGet,
  pluginSchemaValidate,
  pluginVersionList,
  repoBranchCreate,
  repoConfigure,
  repoCreate,
  repoFilePut,
  repoFork,
  repoPrOpen,
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
  agentRepoEdit,
  agentCompose,
  agentSubagentCancel,
  agentSubagentLogs,
  apiKeyRotate,
  auditLogQuery,
  automationUpdate,
  connectionPause,
  connectionUpdate,
  graphIngest,
  graphSyncPush,
  orgSettingsRead,
  orgSettingsWrite,
  workspaceSettingsRead,
  workspaceSettingsWrite,
  commandMenuSearch,
  commandMenuSuggest,
  skillAuthor,
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
  graphRelationshipUpsert,
  semanticRelationshipApprove,
  semanticRelationshipInfer,
  semanticRelationshipList,
  semanticRelationshipSuggest,
  environmentCreate,
  environmentList,
  environmentGet,
  environmentUpdate,
  environmentDelete,
  environmentSetDefault,
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
  a2aCardGet,
  evalDatasetCreate,
  evalDatasetList,
  evalDatasetGet,
  evalDatasetItemAdd,
  evalDatasetFromTraces,
  evalRunStart,
  evalRunStatus,
  evalRunGet,
] as const;

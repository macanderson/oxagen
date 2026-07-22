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
import { agentSandboxRename } from "./agent.sandbox.rename";
import { agentSandboxFilesList } from "./agent.sandbox_file.list";
import { agentSandboxFileRead } from "./agent.sandbox_file.read";
import { agentSandboxLogsList } from "./agent.sandbox_log.list";
import { agentSandboxList } from "./agent.sandbox.list";
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
import { a2aCardGet } from "./a2a.card.get";
import { agentDeploy } from "./agent.deploy";
import { agentTriggerCreate } from "./agent.trigger.create";
import { agentTriggerUpdate } from "./agent.trigger.update";
import { agentTriggerDelete } from "./agent.trigger.delete";
import { agentTriggerList } from "./agent.trigger.list";
import { agentExecutionList } from "./agent.execution.list";
import { modelCapabilityList } from "./model.capability.list";
import { agentExecutionRecord } from "./agent.execution.record";
import { agentTraceGet } from "./agent.trace.get";
import { agentDebugTrace } from "./agent.debug.trace";
import { telemetryErrorCluster } from "./telemetry.error.cluster";
import { telemetryStellaIngest } from "./telemetry.stella.ingest";
import { agentUiRender } from "./agent.ui.render";
import { documentsGenerate } from "./document.generate";
import { documentsPdfCreate } from "./document.pdf.create";
import { markdownGenerate } from "./markdown.generate";
import { mermaidGenerate } from "./mermaid.generate";
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
import { agentPlanApprove } from "./agent.plan.approve";
import { agentPlanCreate } from "./agent.plan.create";
import { agentPlanGet } from "./agent.plan.get";
import { agentPlanList } from "./agent.plan.list";
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
import { resellerCustomerCreate } from "./billing.reseller_customer.create";
import { resellerCustomerList } from "./billing.reseller_customer.list";
import { resellerCustomerUpdate } from "./billing.reseller_customer.update";
import { resellerCustomerArchive } from "./billing.reseller_customer.archive";
import { resellerPricePlanCreate } from "./billing.reseller_price_plan.create";
import { resellerPricePlanList } from "./billing.reseller_price_plan.list";
import { resellerPricePlanUpdate } from "./billing.reseller_price_plan.update";
import { resellerAttributionRuleSave } from "./billing.reseller_attribution_rule.save";
import { resellerAttributionRuleList } from "./billing.reseller_attribution_rule.list";
import { resellerAttributionRuleDelete } from "./billing.reseller_attribution_rule.delete";
import { resellerRebillPreview } from "./billing.reseller_rebill.preview";
import { resellerRebillPush } from "./billing.reseller_rebill.push";
import { resellerRebillListRuns } from "./billing.reseller_rebill.list_runs";
import { resellerStripeConfigure } from "./billing.reseller_stripe.configure";
import { resellerStripeStatus } from "./billing.reseller_stripe.status";
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
import { automationGet } from "./automation.get";
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
import { graphNodeLabelsGet } from "./graph.node_label.get";
import { knowledgeNodeRefSchema } from "./knowledge.node-ref";
import { graphNodeGet } from "./graph.node.get";
import { graphNodeSearch } from "./graph.node.search";
import { graphSearch } from "./graph.search";
import { webSearch } from "./web.search";
import { webFetch } from "./web.fetch";
import { pluginSchemaGet } from "./plugin.schema.get";
import { pluginSchemaValidate } from "./plugin.schema.validate";
import { pluginVersionList } from "./plugin.version.list";
import { repoBranchCreate } from "./repo.branch.create";
import { repoBranchList } from "./repo.branch.list";
import { repoConfigure } from "./repo.configure";
import { repoCreate } from "./repo.create";
import { repoFilePut } from "./repo.file.put";
import { repoFork } from "./repo.fork";
import { repoPrOpen } from "./repo.pr.open";
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
import { agentRepoEdit } from "./agent.repo.edit";
import { agentCompose } from "./agent.compose";
import { agentSubagentCancel } from "./agent.subagent.cancel";
import { agentSubagentLogs } from "./agent.subagent.logs";
import { apiKeyRotate } from "./api.key.rotate";
import { auditLogQuery } from "./audit.log.query";
import { automationUpdate } from "./automation.update";
import { connectionPause } from "./connection.pause";
import { connectionUpdate } from "./connection.update";
import { orgSettingsRead } from "./org.settings.read";
import { orgSettingsWrite } from "./org.settings.write";
import { workspaceSettingsRead } from "./workspace.settings.read";
import { workspaceSettingsWrite } from "./workspace.settings.write";
import { commandMenuSearch } from "./command.menu.search";
import { commandMenuSuggest } from "./command.menu.suggest";
import { referenceSearch } from "./reference.search";
import { referenceCite } from "./reference.cite";
import { skillAuthor } from "./skill.author";
import { skillDraft } from "./skill.draft";
import { skillRevise } from "./skill.revise";
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
import { sandboxTemplateCreate } from "./sandbox.template.create";
import { sandboxTemplateList } from "./sandbox.template.list";
import { sandboxTemplateGet } from "./sandbox.template.get";
import { sandboxTemplateUpdate } from "./sandbox.template.update";
import { sandboxTemplateDelete } from "./sandbox.template.delete";
import { sandboxTemplateSetDefault } from "./sandbox.template.set_default";
import { sandboxTemplateSetTools } from "./sandbox.template.set_tools";
import { sandboxTemplateExport } from "./sandbox.template.export";
import { sandboxTemplateImport } from "./sandbox.template.import";
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
import { evalRunList } from "./eval.run.list";
import { evalRunSeries } from "./eval.run.series";
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
export {
  sandboxProviderSchema,
  sandboxResourcesSchema,
  sandboxNetworkModeSchema,
  sandboxNetworkSchema,
  sandboxSecretSelectionSchema,
  sandboxLiteralEnvSchema,
  sandboxPackageManagerSchema,
  sandboxTemplatePackageGroupSchema,
  sandboxTemplatePackagesSchema,
  sandboxToolKindSchema,
  sandboxTemplateToolSchema,
  manifestSecretKeySchema,
  sandboxTemplateManifestSchema,
  SANDBOX_TEMPLATE_MANIFEST_KIND,
  SECRET_KEY_NAME_PATTERN,
} from "./sandbox-template-manifest";
export type {
  SandboxProvider,
  SandboxResources,
  SandboxNetworkMode,
  SandboxNetwork,
  SandboxSecretSelection,
  SandboxLiteralEnv,
  SandboxPackageManager,
  SandboxTemplatePackageGroup,
  SandboxTemplatePackages,
  SandboxToolKind,
  SandboxTemplateTool,
  ManifestSecretKey,
  SandboxTemplateManifest,
  SandboxTemplateManifestInput,
} from "./sandbox-template-manifest";

// Shared reseller-revenue wire schemas (not capabilities themselves) — re-exported
// so surfaces and the app import one canonical shape, and so the contracts guard
// sees this sibling module referenced.
export {
  resellerCustomerStatusSchema,
  resellerPricingModeSchema,
  resellerMatchKindSchema,
  resellerRebillStatusSchema,
  resellerCustomerSchema,
  resellerPricePlanSchema,
  resellerAttributionRuleSchema,
  resellerRebillLineItemSchema,
  resellerRebillPreviewSchema,
  resellerRebillRunSchema,
  isoInstant,
} from "./reseller-shared";
export type {
  ResellerCustomerStatus,
  ResellerPricingMode,
  ResellerMatchKind,
  ResellerRebillStatus,
  ResellerCustomer,
  ResellerPricePlan,
  ResellerAttributionRule,
  ResellerRebillLineItem,
  ResellerRebillPreview,
  ResellerRebillRun,
} from "./reseller-shared";

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
  agentSandboxRename,
  agentSandboxFilesList,
  agentSandboxFileRead,
  agentSandboxLogsList,
  agentSandboxList,
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
  a2aCardGet,
  agentDeploy,
  agentTriggerCreate,
  agentTriggerUpdate,
  agentTriggerDelete,
  agentTriggerList,
  agentExecutionList,
  agentExecutionRecord,
  modelCapabilityList,
  agentUiRender,
  documentsGenerate,
  documentsPdfCreate,
  markdownGenerate,
  mermaidGenerate,
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
  agentPlanApprove,
  agentPlanCreate,
  agentPlanGet,
  agentPlanList,
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
  telemetryStellaIngest,
  agentTaskBackgroundCancel,
  agentTaskBackgroundRead,
  agentTaskBackgroundStart,
  agentToolList,
  billingCreditsPurchase,
  billingSubscriptionRead,
  billingSubscriptionUpgradeStart,
  billingUsageBreakdown,
  resellerCustomerCreate,
  resellerCustomerList,
  resellerCustomerUpdate,
  resellerCustomerArchive,
  resellerPricePlanCreate,
  resellerPricePlanList,
  resellerPricePlanUpdate,
  resellerAttributionRuleSave,
  resellerAttributionRuleList,
  resellerAttributionRuleDelete,
  resellerRebillPreview,
  resellerRebillPush,
  resellerRebillListRuns,
  resellerStripeConfigure,
  resellerStripeStatus,
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
  automationGet,
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
  graphNodeLabelsGet,
  knowledgeNodeRefSchema,
  graphNodeGet,
  graphNodeSearch,
  graphSearch,
  webSearch,
  webFetch,
  pluginSchemaGet,
  pluginSchemaValidate,
  pluginVersionList,
  repoBranchCreate,
  repoBranchList,
  repoConfigure,
  repoCreate,
  repoFilePut,
  repoFork,
  repoPrOpen,
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
  agentRepoEdit,
  agentCompose,
  agentSubagentCancel,
  agentSubagentLogs,
  apiKeyRotate,
  auditLogQuery,
  automationUpdate,
  connectionPause,
  connectionUpdate,
  orgSettingsRead,
  orgSettingsWrite,
  workspaceSettingsRead,
  workspaceSettingsWrite,
  commandMenuSearch,
  commandMenuSuggest,
  referenceSearch,
  referenceCite,
  skillAuthor,
  skillDraft,
  skillRevise,
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
  sandboxTemplateCreate,
  sandboxTemplateList,
  sandboxTemplateGet,
  sandboxTemplateUpdate,
  sandboxTemplateDelete,
  sandboxTemplateSetDefault,
  sandboxTemplateSetTools,
  sandboxTemplateExport,
  sandboxTemplateImport,
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
  evalDatasetCreate,
  evalDatasetList,
  evalDatasetGet,
  evalDatasetItemAdd,
  evalDatasetFromTraces,
  evalRunStart,
  evalRunStatus,
  evalRunGet,
  evalRunList,
  evalRunSeries,
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
  agentSandboxRename,
  agentSandboxFilesList,
  agentSandboxFileRead,
  agentSandboxLogsList,
  agentSandboxList,
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
  agentPlanApprove,
  agentPlanCreate,
  agentPlanGet,
  agentPlanList,
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
  telemetryStellaIngest,
  agentTaskBackgroundCancel,
  agentTaskBackgroundRead,
  agentTaskBackgroundStart,
  agentToolList,
  billingCreditsPurchase,
  billingSubscriptionRead,
  billingSubscriptionUpgradeStart,
  billingUsageBreakdown,
  resellerCustomerCreate,
  resellerCustomerList,
  resellerCustomerUpdate,
  resellerCustomerArchive,
  resellerPricePlanCreate,
  resellerPricePlanList,
  resellerPricePlanUpdate,
  resellerAttributionRuleSave,
  resellerAttributionRuleList,
  resellerAttributionRuleDelete,
  resellerRebillPreview,
  resellerRebillPush,
  resellerRebillListRuns,
  resellerStripeConfigure,
  resellerStripeStatus,
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
  automationGet,
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
  modelCapabilityList,
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
  graphNodeLabelsGet,
  graphNodeGet,
  graphNodeSearch,
  graphSearch,
  webSearch,
  webFetch,
  pluginSchemaGet,
  pluginSchemaValidate,
  pluginVersionList,
  repoBranchCreate,
  repoBranchList,
  repoConfigure,
  repoCreate,
  repoFilePut,
  repoFork,
  repoPrOpen,
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
  agentRepoEdit,
  agentCompose,
  agentSubagentCancel,
  agentSubagentLogs,
  apiKeyRotate,
  auditLogQuery,
  automationUpdate,
  connectionPause,
  connectionUpdate,
  orgSettingsRead,
  orgSettingsWrite,
  workspaceSettingsRead,
  workspaceSettingsWrite,
  commandMenuSearch,
  commandMenuSuggest,
  referenceSearch,
  referenceCite,
  skillAuthor,
  skillDraft,
  skillRevise,
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
  sandboxTemplateCreate,
  sandboxTemplateList,
  sandboxTemplateGet,
  sandboxTemplateUpdate,
  sandboxTemplateDelete,
  sandboxTemplateSetDefault,
  sandboxTemplateSetTools,
  sandboxTemplateExport,
  sandboxTemplateImport,
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
  a2aCardGet,
  evalDatasetCreate,
  evalDatasetList,
  evalDatasetGet,
  evalDatasetItemAdd,
  evalDatasetFromTraces,
  evalRunStart,
  evalRunStatus,
  evalRunGet,
  evalRunList,
  evalRunSeries,
  routerPolicyGet,
  routerPolicySet,
  routerStatsList,
  routerDecisionPreview,
] as const;

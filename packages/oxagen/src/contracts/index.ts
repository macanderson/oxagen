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
import { agentDefinitionCreate } from "./agent.definition.create";
import { agentDefinitionUpdate } from "./agent.definition.update";
import { agentDefinitionPublish } from "./agent.definition.publish";
import { agentDefinitionGet } from "./agent.definition.get";
import { agentDefinitionList } from "./agent.definition.list";
import { agentDeploy } from "./agent.deploy";
import { agentTriggerCreate } from "./agent.trigger.create";
import { agentTriggerUpdate } from "./agent.trigger.update";
import { agentTriggerDelete } from "./agent.trigger.delete";
import { agentTriggerList } from "./agent.trigger.list";
import { agentExecutionRecord } from "./agent.execution.record";
import { agentUiRender } from "./agent.ui.render";
import { brandkitApply } from "./brandkit.apply";
import { documentsGenerate } from "./documents.generate";
import { documentsPdfCreate } from "./documents.pdf.create";
import { markdownGenerate } from "./markdown.generate";
import { mermaidGenerate } from "./mermaid.generate";
import { agentMcpList } from "./agent.mcp.list";
import { agentMcpRegister } from "./agent.mcp.register";
import { agentMcpSetEnabled } from "./agent.mcp.set_enabled";
import { agentMcpDelete } from "./agent.mcp.delete";
import { agentMcpConsentResolve } from "./agent.mcp.consent.resolve";
import { agentMcpConsentList } from "./agent.mcp.consent.list";
import { agentMemoryRecall } from "./agent.memory.recall";
import { agentMemoryWrite } from "./agent.memory.write";
import { agentPlanApprove } from "./agent.plan.approve";
import { agentPlanCreate } from "./agent.plan.create";
import { agentSkillList } from "./agent.skill.list";
import { agentSkillLoad } from "./agent.skill.load";
import { agentSubagentFanoutGet } from "./agent.subagent.fanout.get";
import { agentSubagentFanoutList } from "./agent.subagent.fanout.list";
import { agentTaskBackgroundCancel } from "./agent.task.background.cancel";
import { agentTaskBackgroundRead } from "./agent.task.background.read";
import { agentTaskBackgroundStart } from "./agent.task.background.start";
import { agentToolList } from "./agent.tool.list";
import { billingCreditsPurchase } from "./billing.credits.purchase";
import { billingSubscriptionRead } from "./billing.subscription.read";
import { billingSubscriptionUpgradeStart } from "./billing.subscription.upgrade.start";
import { chatMessageExecution } from "./chat.message.execution";
import { chatMessageSend } from "./chat.message.send";
import { conversationArchive } from "./conversation.archive";
import { conversationDelete } from "./conversation.delete";
import { conversationList } from "./conversation.list";
import { conversationPurge } from "./conversation.purge";
import { conversationRename } from "./conversation.rename";
import { conversationFilesList } from "./conversation.files.list";
import { formFill } from "./form.fill";
import { organizationCreate } from "./organization.create";
import { orgMemberAdd } from "./org.member.add";
import { orgMemberInviteAccept } from "./org.member.invite.accept";
import { orgMemberInviteDecline } from "./org.member.invite.decline";
import { orgMemberRemove } from "./org.member.remove";
import { orgMemberRoleChange } from "./org.member.role.change";
import { workspaceCreate } from "./workspace.create";
import { videoGenerate } from "./video.generate";
import { imageGenerate } from "./image.generate";
import { svgGenerate } from "./svg.generate";
import { systemInstallInstructions } from "./system.install.instructions";
import { userPreferencesRead } from "./user.preferences.read";
import { userPreferencesWrite } from "./user.preferences.write";
import { workspaceModelSettingsRead } from "./workspace.model.settings.read";
import { workspaceModelSettingsWrite } from "./workspace.model.settings.write";
import { promptSettingsRead } from "./prompt.settings.read";
import { promptSettingsWrite } from "./prompt.settings.write";
import { notificationsList } from "./notifications.list";
import { notificationsMark } from "./notifications.mark";
import { pluginCatalogBrowse } from "./plugin.catalog.browse";
import { pluginCatalogGet } from "./plugin.catalog.get";
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
import { formCreate } from "./form.create";
import { formSubmit } from "./form.submit";
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
import { graphNodeGet } from "./graph.node.get";
import { graphNodeDelete } from "./graph.node.delete";
import { graphNodeSearch } from "./graph.node.search";
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
import { repoConfigure } from "./repo.configure";
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
import { agentCompose } from "./agent.compose";
import { agentSubagentCancel } from "./agent.subagent.cancel";
import { agentSubagentLogs } from "./agent.subagent.logs";
import { apiKeyRotate } from "./api.key.rotate";
import { auditLogQuery } from "./audit.log.query";
import { automationUpdate } from "./automation.update";
import { connectionPause } from "./connection.pause";
import { connectionUpdate } from "./connection.update";
import { graphIngest } from "./graph.ingest";
import { orgSettingsRead } from "./org.settings.read";
import { orgSettingsWrite } from "./org.settings.write";
import { workspaceSettingsRead } from "./workspace.settings.read";
import { workspaceSettingsWrite } from "./workspace.settings.write";

export {
  apiKeyCreate,
  apiKeyRevoke,
  archiveCreate,
  assetUpload,
  agentApprovalResolve,
  agentCodeExecute,
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
  agentExecutionRecord,
  agentUiRender,
  brandkitApply,
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
  agentPlanApprove,
  agentPlanCreate,
  agentSkillList,
  agentSkillLoad,
  agentSubagentFanoutGet,
  agentSubagentFanoutList,
  agentTaskBackgroundCancel,
  agentTaskBackgroundRead,
  agentTaskBackgroundStart,
  agentToolList,
  billingCreditsPurchase,
  billingSubscriptionRead,
  billingSubscriptionUpgradeStart,
  chatMessageExecution,
  chatMessageSend,
  conversationArchive,
  conversationDelete,
  conversationList,
  conversationPurge,
  conversationRename,
  conversationFilesList,
  formFill,
  organizationCreate,
  orgMemberAdd,
  orgMemberInviteAccept,
  orgMemberInviteDecline,
  orgMemberRemove,
  orgMemberRoleChange,
  workspaceCreate,
  videoGenerate,
  imageGenerate,
  svgGenerate,
  systemInstallInstructions,
  userPreferencesRead,
  userPreferencesWrite,
  workspaceModelSettingsRead,
  workspaceModelSettingsWrite,
  promptSettingsRead,
  promptSettingsWrite,
  notificationsList,
  notificationsMark,
  pluginCatalogBrowse,
  pluginCatalogGet,
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
  formCreate,
  formSubmit,
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
  graphNodeGet,
  graphNodeDelete,
  graphNodeSearch,
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
  repoConfigure,
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
  agentCompose,
  agentSubagentCancel,
  agentSubagentLogs,
  apiKeyRotate,
  auditLogQuery,
  automationUpdate,
  connectionPause,
  connectionUpdate,
  graphIngest,
  orgSettingsRead,
  orgSettingsWrite,
  workspaceSettingsRead,
  workspaceSettingsWrite,
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
  brandkitApply,
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
  agentPlanApprove,
  agentPlanCreate,
  agentSkillList,
  agentSkillLoad,
  agentSubagentFanoutGet,
  agentSubagentFanoutList,
  agentTaskBackgroundCancel,
  agentTaskBackgroundRead,
  agentTaskBackgroundStart,
  agentToolList,
  billingCreditsPurchase,
  billingSubscriptionRead,
  billingSubscriptionUpgradeStart,
  chatMessageExecution,
  chatMessageSend,
  conversationArchive,
  conversationDelete,
  conversationList,
  conversationPurge,
  conversationRename,
  conversationFilesList,
  formFill,
  organizationCreate,
  orgMemberAdd,
  orgMemberInviteAccept,
  orgMemberInviteDecline,
  orgMemberRemove,
  orgMemberRoleChange,
  workspaceCreate,
  videoGenerate,
  imageGenerate,
  svgGenerate,
  systemInstallInstructions,
  userPreferencesRead,
  userPreferencesWrite,
  workspaceModelSettingsRead,
  workspaceModelSettingsWrite,
  promptSettingsRead,
  promptSettingsWrite,
  notificationsList,
  notificationsMark,
  pluginCatalogBrowse,
  pluginCatalogGet,
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
  formCreate,
  formSubmit,
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
  graphNodeGet,
  graphNodeDelete,
  graphNodeSearch,
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
  repoConfigure,
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
  agentCompose,
  agentSubagentCancel,
  agentSubagentLogs,
  apiKeyRotate,
  auditLogQuery,
  automationUpdate,
  connectionPause,
  connectionUpdate,
  graphIngest,
  orgSettingsRead,
  orgSettingsWrite,
  workspaceSettingsRead,
  workspaceSettingsWrite,
] as const;

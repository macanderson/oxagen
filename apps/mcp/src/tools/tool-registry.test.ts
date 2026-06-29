// tool-registry.test.ts — config-derived parity guard.
//
// Computes the expected set of MCP tool names by filtering the canonical
// `contracts` array from @oxagen/oxagen/contracts to those whose `surfaces`
// includes "mcp". Compares that set against the union of `metadata.name`
// values exported by every tool file in this directory.
//
// If a contract gains the "mcp" surface without a corresponding tool file,
// or if a tool file's metadata.name diverges from the contract name, this
// test fails — no stale or missing tools can ship silently.
//
// No hardcoded count; the expected set is derived from the contracts array.

import { describe, it, expect } from "vitest";
import { contracts } from "@oxagen/oxagen/contracts";

// ── Import all tool metadata ──────────────────────────────────────────────────

import { metadata as apiKeyCreateMetadata } from "./api.key.create";
import { metadata as apiKeyRevokeMetadata } from "./api.key.revoke";
import { metadata as agentApprovalResolveMetadata } from "./agent.approval.resolve";
import { metadata as agentCodeExecuteMetadata } from "./agent.code.execute";
import { metadata as agentExecutionRecordMetadata } from "./agent.execution.record";
import { metadata as archiveCreateMetadata } from "./archive.create";
import { metadata as agentMcpListMetadata } from "./agent.mcp.list";
import { metadata as agentMcpRegisterMetadata } from "./agent.mcp.register";
import { metadata as agentMemoryRecallMetadata } from "./agent.memory.recall";
import { metadata as agentMemoryWriteMetadata } from "./agent.memory.write";
import { metadata as agentMemoryListMetadata } from "./agent.memory.list";
import { metadata as agentPlanApproveMetadata } from "./agent.plan.approve";
import { metadata as agentPlanCreateMetadata } from "./agent.plan.create";
import { metadata as agentSkillListMetadata } from "./agent.skill.list";
import { metadata as agentSkillLoadMetadata } from "./agent.skill.load";
import { metadata as agentTaskBackgroundCancelMetadata } from "./agent.task.background.cancel";
import { metadata as agentTaskBackgroundReadMetadata } from "./agent.task.background.read";
import { metadata as agentTaskBackgroundStartMetadata } from "./agent.task.background.start";
import { metadata as agentSubagentAggregateMetadata } from "./agent.subagent.aggregate";
import { metadata as agentSubagentDispatchMetadata } from "./agent.subagent.dispatch";
import { metadata as agentSubagentFanoutGetMetadata } from "./agent.subagent.fanout.get";
import { metadata as agentSubagentFanoutListMetadata } from "./agent.subagent.fanout.list";
import { metadata as agentToolListMetadata } from "./agent.tool.list";
import { metadata as agentDefinitionCreateMetadata } from "./agent.definition.create";
import { metadata as agentDefinitionUpdateMetadata } from "./agent.definition.update";
import { metadata as agentDefinitionPublishMetadata } from "./agent.definition.publish";
import { metadata as agentDefinitionGetMetadata } from "./agent.definition.get";
import { metadata as agentDefinitionListMetadata } from "./agent.definition.list";
import { metadata as agentDeployMetadata } from "./agent.deploy";
import { metadata as agentTriggerCreateMetadata } from "./agent.trigger.create";
import { metadata as agentTriggerUpdateMetadata } from "./agent.trigger.update";
import { metadata as agentTriggerDeleteMetadata } from "./agent.trigger.delete";
import { metadata as agentTriggerListMetadata } from "./agent.trigger.list";
import { metadata as assetUploadMetadata } from "./asset.upload";
import { metadata as billingCreditsPurchaseMetadata } from "./billing.credits.purchase";
import { metadata as billingSubscriptionReadMetadata } from "./billing.subscription.read";
import { metadata as billingSubscriptionUpgradeStartMetadata } from "./billing.subscription.upgrade.start";
import { metadata as chatMessageExecutionMetadata } from "./chat.message.execution";
import { metadata as chatMessageSendMetadata } from "./chat.message.send";
import { metadata as conversationArchiveMetadata } from "./conversation.archive";
import { metadata as conversationDeleteMetadata } from "./conversation.delete";
import { metadata as conversationListMetadata } from "./conversation.list";
import { metadata as conversationPurgeMetadata } from "./conversation.purge";
import { metadata as conversationRenameMetadata } from "./conversation.rename";
import { metadata as documentsGenerateMetadata } from "./documents.generate";
import { metadata as documentsPdfCreateMetadata } from "./documents.pdf.create";
import { metadata as formFillMetadata } from "./form.fill";
import { metadata as imageGenerateMetadata } from "./image.generate";
import { metadata as notificationsListMetadata } from "./notifications.list";
import { metadata as notificationsMarkMetadata } from "./notifications.mark";
import { metadata as researchSwarmStartMetadata } from "./research.swarm.start";
import { metadata as researchSwarmStatusMetadata } from "./research.swarm.status";
import { metadata as organizationCreateMetadata } from "./organization.create";
import { metadata as pluginCatalogBrowseMetadata } from "./plugin.catalog.browse";
import { metadata as pluginCatalogGetMetadata } from "./plugin.catalog.get";
import { metadata as pluginCatalogSyncMetadata } from "./plugin.catalog.sync";
import { metadata as pluginCredentialReauthMetadata } from "./plugin.credential.reauth";
import { metadata as pluginCredentialSetSecretMetadata } from "./plugin.credential.set_secret";
import { metadata as pluginOrgInstallMetadata } from "./plugin.org.install";
import { metadata as pluginOrgInstallBulkMetadata } from "./plugin.org.install_bulk";
import { metadata as pluginOrgListMetadata } from "./plugin.org.list";
import { metadata as pluginOrgSetEnabledMetadata } from "./plugin.org.set_enabled";
import { metadata as pluginOrgUninstallMetadata } from "./plugin.org.uninstall";
import { metadata as pluginRegistryAddMetadata } from "./plugin.registry.add";
import { metadata as pluginRegistryListMetadata } from "./plugin.registry.list";
import { metadata as pluginRegistryRemoveMetadata } from "./plugin.registry.remove";
import { metadata as pluginSettingsSetAuthAlertsMetadata } from "./plugin.settings.set_auth_alerts";
import { metadata as pluginWorkspaceSetEnabledMetadata } from "./plugin.workspace.set_enabled";
import { metadata as orgMemberAddMetadata } from "./org.member.add";
import { metadata as orgMemberInviteAcceptMetadata } from "./org.member.invite.accept";
import { metadata as orgMemberInviteDeclineMetadata } from "./org.member.invite.decline";
import { metadata as orgMemberRemoveMetadata } from "./org.member.remove";
import { metadata as orgMemberRoleChangeMetadata } from "./org.member.role.change";
import { metadata as promptSettingsReadMetadata } from "./prompt.settings.read";
import { metadata as promptSettingsWriteMetadata } from "./prompt.settings.write";
import { metadata as svgGenerateMetadata } from "./svg.generate";
import { metadata as systemInstallInstructionsMetadata } from "./system.install.instructions";
import { metadata as userPreferencesReadMetadata } from "./user.preferences.read";
import { metadata as userPreferencesWriteMetadata } from "./user.preferences.write";
import { metadata as videoGenerateMetadata } from "./video.generate";
import { metadata as workspaceCreateMetadata } from "./workspace.create";
import { metadata as orgListMetadata } from "./org.list";
import { metadata as workspaceListMetadata } from "./workspace.list";
import { metadata as workspaceModelSettingsReadMetadata } from "./workspace.model.settings.read";
import { metadata as workspaceModelSettingsWriteMetadata } from "./workspace.model.settings.write";
import { metadata as workflowRunMetadata } from "./workflow.run";
import { metadata as workflowStatusMetadata } from "./workflow.status";
import { metadata as workflowCancelMetadata } from "./workflow.cancel";
import { metadata as automationCreateMetadata } from "./automation.create";
import { metadata as automationDisableMetadata } from "./automation.disable";
import { metadata as automationEnableMetadata } from "./automation.enable";
import { metadata as automationListMetadata } from "./automation.list";
import { metadata as automationTriggerMetadata } from "./automation.trigger";
import { metadata as conversationChatMetadata } from "./conversation.chat";
import { metadata as documentCreateMetadata } from "./document.create";
import { metadata as documentListMetadata } from "./document.list";
import { metadata as documentReadMetadata } from "./document.read";
import { metadata as imageAnalyzeMetadata } from "./image.analyze";
import { metadata as imageCreateMetadata } from "./image.create";
import { metadata as imageListMetadata } from "./image.list";
import { metadata as skillWorkspaceListMetadata } from "./skill.workspace.list";
import { metadata as workspaceInviteSendMetadata } from "./workspace.invite.send";
import { metadata as workspaceMemberListMetadata } from "./workspace.member.list";
import { metadata as connectionListMetadata } from "./connection.list";
import { metadata as connectionCreateMetadata } from "./connection.create";
import { metadata as connectionGetMetadata } from "./connection.get";
import { metadata as connectionDeleteMetadata } from "./connection.delete";
import { metadata as connectionPreviewMetadata } from "./connection.preview";
import { metadata as connectionMappingsSuggestMetadata } from "./connection.mappings.suggest";
import { metadata as connectionMappingsGetMetadata } from "./connection.mappings.get";
import { metadata as connectionMappingsSetMetadata } from "./connection.mappings.set";
import { metadata as privacyDataEraseMetadata } from "./privacy.data.erase";
import { metadata as privacyDataExportMetadata } from "./privacy.data.export";
import { metadata as graphNodeUpsertMetadata } from "./graph.node.upsert";
import { metadata as graphNodeGetMetadata } from "./graph.node.get";
import { metadata as graphNodeDeleteMetadata } from "./graph.node.delete";
import { metadata as graphNodeSearchMetadata } from "./graph.node.search";
import { metadata as graphSearchMetadata } from "./graph.search";
import { metadata as graphExportMetadata } from "./graph.export";
import { metadata as graphEdgeUpsertMetadata } from "./graph.edge.upsert";
import { metadata as graphEdgeDeleteMetadata } from "./graph.edge.delete";
import { metadata as graphCypherMetadata } from "./graph.cypher";
import { metadata as webSearchMetadata } from "./web.search";
import { metadata as webFetchMetadata } from "./web.fetch";
import { metadata as semanticEdgeApproveMetadata } from "./semantic.edge.approve";
import { metadata as semanticEdgeInferMetadata } from "./semantic.edge.infer";
import { metadata as semanticEdgeListMetadata } from "./semantic.edge.list";
import { metadata as semanticEdgeSuggestMetadata } from "./semantic.edge.suggest";
import { metadata as pluginSchemaGetMetadata } from "./plugin.schema.get";
import { metadata as pluginSchemaValidateMetadata } from "./plugin.schema.validate";
import { metadata as pluginVersionListMetadata } from "./plugin.version.list";
import { metadata as repoConfigureMetadata } from "./repo.configure";
import { metadata as repoMetricsMetadata } from "./repo.metrics";
import { metadata as repoPauseMetadata } from "./repo.pause";
import { metadata as repoResumeMetadata } from "./repo.resume";
import { metadata as repoSyncMetadata } from "./repo.sync";
import { metadata as graphNodeListMetadata } from "./graph.node.list";
import { metadata as graphStatsMetadata } from "./graph.stats";
import { metadata as integrationConfigureMetadata } from "./integration.configure";
import { metadata as integrationDeleteMetadata } from "./integration.delete";
import { metadata as integrationGetMetadata } from "./integration.get";
import { metadata as integrationInstallMetadata } from "./integration.install";
import { metadata as integrationListMetadata } from "./integration.list";
import { metadata as integrationMetricsMetadata } from "./integration.metrics";
import { metadata as integrationSyncMetadata } from "./integration.sync";
import { metadata as ontologyQueryMetadata } from "./ontology.query";
import { metadata as ontologyNeighborsMetadata } from "./ontology.neighbors";
import { metadata as agentComposeMetadata } from "./agent.compose";
import { metadata as agentSubagentCancelMetadata } from "./agent.subagent.cancel";
import { metadata as agentSubagentLogsMetadata } from "./agent.subagent.logs";
import { metadata as apiKeyRotateMetadata } from "./api.key.rotate";
import { metadata as auditLogQueryMetadata } from "./audit.log.query";
import { metadata as automationUpdateMetadata } from "./automation.update";
import { metadata as connectionPauseMetadata } from "./connection.pause";
import { metadata as connectionUpdateMetadata } from "./connection.update";
import { metadata as graphIngestMetadata } from "./graph.ingest";
import { metadata as orgSettingsReadMetadata } from "./org.settings.read";
import { metadata as orgSettingsWriteMetadata } from "./org.settings.write";
import { metadata as workspaceSettingsReadMetadata } from "./workspace.settings.read";
import { metadata as workspaceSettingsWriteMetadata } from "./workspace.settings.write";
// OXA-768 content generation + conversation files
import { metadata as markdownGenerateMetadata } from "./markdown.generate";
import { metadata as mermaidGenerateMetadata } from "./mermaid.generate";
import { metadata as conversationFilesListMetadata } from "./conversation.files.list";
// OXA-768 external MCP consent + lifecycle
import { metadata as agentMcpConsentResolveMetadata } from "./agent.mcp.consent.resolve";
import { metadata as agentMcpConsentListMetadata } from "./agent.mcp.consent.list";
import { metadata as agentMcpSetEnabledMetadata } from "./agent.mcp.set_enabled";
import { metadata as agentMcpDeleteMetadata } from "./agent.mcp.delete";
// OXA-768 skills lifecycle
import { metadata as skillWorkspaceInstallMetadata } from "./skill.workspace.install";
import { metadata as skillVersionListMetadata } from "./skill.version.list";
import { metadata as skillVersionGetMetadata } from "./skill.version.get";
import { metadata as skillVersionUploadMetadata } from "./skill.version.upload";
import { metadata as skillVersionActivateMetadata } from "./skill.version.activate";
import { metadata as skillEditMetadata } from "./skill.edit";
import { metadata as skillExportMetadata } from "./skill.export";
import { metadata as skillMetricsReadMetadata } from "./skill.metrics.read";
import { metadata as skillAuthorMetadata } from "./skill.author";
import { metadata as skillCreateMetadata } from "./skill.create";
import { metadata as skillEnableMetadata } from "./skill.enable";
// Workspace Schema Registry + graph relationship tools (these tool files exist
// and are mounted; this parity list just hadn't imported them yet).
import { metadata as graphRelationshipUpsertMetadata } from "./graph.relationship.upsert";
import { metadata as schemaExportMetadata } from "./schema.export";
import { metadata as schemaLabelDeleteMetadata } from "./schema.label.delete";
import { metadata as schemaLabelUpsertMetadata } from "./schema.label.upsert";
import { metadata as schemaListMetadata } from "./schema.list";
import { metadata as schemaPropertyDeleteMetadata } from "./schema.property.delete";
import { metadata as schemaPropertyUpsertMetadata } from "./schema.property.upsert";
import { metadata as schemaRecommendMetadata } from "./schema.recommend";
import { metadata as schemaReconcileDispatchMetadata } from "./schema.reconcile.dispatch";
import { metadata as schemaReconcileStatusMetadata } from "./schema.reconcile.status";
import { metadata as schemaRegistryConfigMetadata } from "./schema.registry.config";
import { metadata as schemaRegistryGetMetadata } from "./schema.registry.get";
import { metadata as schemaRelationshipDeleteMetadata } from "./schema.relationship.delete";
import { metadata as schemaRelationshipUpsertMetadata } from "./schema.relationship.upsert";
import { metadata as schemaSetupMetadata } from "./schema.setup";
import { metadata as schemaToggleMetadata } from "./schema.toggle";
import { metadata as schemaValidateNodeMetadata } from "./schema.validate.node";
import { metadata as schemaValidateRelationshipMetadata } from "./schema.validate.relationship";
import { metadata as schemaVersionCreateMetadata } from "./schema.version.create";
import { metadata as schemaVersionDiffMetadata } from "./schema.version.diff";
import { metadata as schemaVersionListMetadata } from "./schema.version.list";
import { metadata as schemaVersionPinMetadata } from "./schema.version.pin";
import { metadata as semanticRelationshipApproveMetadata } from "./semantic.relationship.approve";
import { metadata as semanticRelationshipInferMetadata } from "./semantic.relationship.infer";
import { metadata as semanticRelationshipListMetadata } from "./semantic.relationship.list";
import { metadata as semanticRelationshipSuggestMetadata } from "./semantic.relationship.suggest";
// Environment management
import { metadata as environmentCreateMetadata } from "./environment.create";
import { metadata as environmentListMetadata } from "./environment.list";
import { metadata as environmentGetMetadata } from "./environment.get";
import { metadata as environmentUpdateMetadata } from "./environment.update";
import { metadata as environmentDeleteMetadata } from "./environment.delete";
import { metadata as environmentSetDefaultMetadata } from "./environment.set_default";
// Secret / env-vault
import { metadata as secretKeyUpsertMetadata } from "./secret.key.upsert";
import { metadata as secretKeyListMetadata } from "./secret.key.list";
import { metadata as secretKeyDeleteMetadata } from "./secret.key.delete";
import { metadata as secretValueSetMetadata } from "./secret.value.set";
import { metadata as secretValueUnsetMetadata } from "./secret.value.unset";
import { metadata as secretImportEnvMetadata } from "./secret.import_env";
import { metadata as secretRevealMetadata } from "./secret.reveal";
import { metadata as secretExportMetadata } from "./secret.export";
// Code capability tools (code.diff / code.patch / code.format are mcp-surfaced)
import { metadata as codeDiffMetadata } from "./code.diff";
import { metadata as codePatchMetadata } from "./code.patch";
import { metadata as codeFormatMetadata } from "./code.format";
// Memory decay policy tools (OXA-1374)
import { metadata as agentMemoryPolicyReadMetadata } from "./agent.memory.policy.read";
import { metadata as agentMemoryPolicyWriteMetadata } from "./agent.memory.policy.write";
// Memory CRUD (delete/remember/update added in agent-memory work)
import { metadata as agentMemoryDeleteMetadata } from "./agent.memory.delete";
import { metadata as agentMemoryRememberMetadata } from "./agent.memory.remember";
import { metadata as agentMemoryUpdateMetadata } from "./agent.memory.update";
// Agent feature verification
import { metadata as agentFeatureVerifyMetadata } from "./agent.feature.verify";
// Sandbox lifecycle (agent.sandbox.*)
import { metadata as agentSandboxExecMetadata } from "./agent.sandbox.exec";
import { metadata as agentSandboxSnapshotMetadata } from "./agent.sandbox.snapshot";
import { metadata as agentSandboxStartMetadata } from "./agent.sandbox.start";
import { metadata as agentSandboxStopMetadata } from "./agent.sandbox.stop";
// Browser automation (browser.*)
import { metadata as browserClickMetadata } from "./browser.click";
import { metadata as browserFillMetadata } from "./browser.fill";
import { metadata as browserNavigateMetadata } from "./browser.navigate";
import { metadata as browserReadMetadata } from "./browser.read";
import { metadata as browserRefreshMetadata } from "./browser.refresh";
import { metadata as browserScreenshotMetadata } from "./browser.screenshot";
import { metadata as browserSubmitMetadata } from "./browser.submit";
// Code-map retrieval (code.map)
import { metadata as codeMapMetadata } from "./code.map";
// Graph sync push (graph.sync.push)
import { metadata as graphSyncPushMetadata } from "./graph.sync.push";
// Memory import tools (agent.memory.import.*)
import { metadata as agentMemoryImportCommitMetadata } from "./agent.memory.import.commit";
import { metadata as agentMemoryImportParseMetadata } from "./agent.memory.import.parse";

// ── Build the registered tool name list ───────────────────────────────────────

const allToolMetadata = [
  apiKeyCreateMetadata,
  apiKeyRevokeMetadata,
  agentApprovalResolveMetadata,
  agentCodeExecuteMetadata,
  agentExecutionRecordMetadata,
  agentMcpListMetadata,
  agentMcpRegisterMetadata,
  agentMemoryRecallMetadata,
  agentMemoryWriteMetadata,
  agentMemoryListMetadata,
  agentPlanApproveMetadata,
  agentPlanCreateMetadata,
  agentSkillListMetadata,
  agentSkillLoadMetadata,
  agentTaskBackgroundCancelMetadata,
  agentTaskBackgroundReadMetadata,
  agentTaskBackgroundStartMetadata,
  agentSubagentAggregateMetadata,
  agentSubagentDispatchMetadata,
  agentSubagentFanoutGetMetadata,
  agentSubagentFanoutListMetadata,
  agentToolListMetadata,
  agentDefinitionCreateMetadata,
  agentDefinitionUpdateMetadata,
  agentDefinitionPublishMetadata,
  agentDefinitionGetMetadata,
  agentDefinitionListMetadata,
  agentDeployMetadata,
  agentTriggerCreateMetadata,
  agentTriggerUpdateMetadata,
  agentTriggerDeleteMetadata,
  agentTriggerListMetadata,
  archiveCreateMetadata,
  assetUploadMetadata,
  billingCreditsPurchaseMetadata,
  billingSubscriptionReadMetadata,
  billingSubscriptionUpgradeStartMetadata,
  chatMessageExecutionMetadata,
  chatMessageSendMetadata,
  conversationArchiveMetadata,
  conversationDeleteMetadata,
  conversationListMetadata,
  conversationPurgeMetadata,
  conversationRenameMetadata,
  documentsGenerateMetadata,
  documentsPdfCreateMetadata,
  formFillMetadata,
  imageGenerateMetadata,
  notificationsListMetadata,
  notificationsMarkMetadata,
  researchSwarmStartMetadata,
  researchSwarmStatusMetadata,
  organizationCreateMetadata,
  orgMemberAddMetadata,
  orgMemberInviteAcceptMetadata,
  orgMemberInviteDeclineMetadata,
  orgMemberRemoveMetadata,
  orgMemberRoleChangeMetadata,
  pluginCatalogBrowseMetadata,
  pluginCatalogGetMetadata,
  pluginCatalogSyncMetadata,
  pluginCredentialReauthMetadata,
  pluginCredentialSetSecretMetadata,
  pluginOrgInstallMetadata,
  pluginOrgInstallBulkMetadata,
  pluginOrgListMetadata,
  pluginOrgSetEnabledMetadata,
  pluginOrgUninstallMetadata,
  pluginRegistryAddMetadata,
  pluginRegistryListMetadata,
  pluginRegistryRemoveMetadata,
  pluginSettingsSetAuthAlertsMetadata,
  pluginWorkspaceSetEnabledMetadata,
  promptSettingsReadMetadata,
  promptSettingsWriteMetadata,
  svgGenerateMetadata,
  systemInstallInstructionsMetadata,
  userPreferencesReadMetadata,
  userPreferencesWriteMetadata,
  videoGenerateMetadata,
  workspaceCreateMetadata,
  orgListMetadata,
  workspaceListMetadata,
  workspaceModelSettingsReadMetadata,
  workspaceModelSettingsWriteMetadata,
  workflowRunMetadata,
  workflowStatusMetadata,
  workflowCancelMetadata,
  automationCreateMetadata,
  automationDisableMetadata,
  automationEnableMetadata,
  automationListMetadata,
  automationTriggerMetadata,
  conversationChatMetadata,
  documentCreateMetadata,
  documentListMetadata,
  documentReadMetadata,
  imageAnalyzeMetadata,
  imageCreateMetadata,
  imageListMetadata,
  skillWorkspaceListMetadata,
  workspaceInviteSendMetadata,
  workspaceMemberListMetadata,
  connectionListMetadata,
  connectionCreateMetadata,
  connectionGetMetadata,
  connectionDeleteMetadata,
  connectionPreviewMetadata,
  connectionMappingsSuggestMetadata,
  connectionMappingsGetMetadata,
  connectionMappingsSetMetadata,
  privacyDataEraseMetadata,
  privacyDataExportMetadata,
  graphNodeUpsertMetadata,
  graphNodeGetMetadata,
  graphNodeDeleteMetadata,
  graphNodeSearchMetadata,
  graphSearchMetadata,
  graphExportMetadata,
  graphEdgeUpsertMetadata,
  graphEdgeDeleteMetadata,
  graphCypherMetadata,
  webSearchMetadata,
  webFetchMetadata,
  semanticEdgeApproveMetadata,
  semanticEdgeInferMetadata,
  semanticEdgeListMetadata,
  semanticEdgeSuggestMetadata,
  pluginSchemaGetMetadata,
  pluginSchemaValidateMetadata,
  pluginVersionListMetadata,
  repoConfigureMetadata,
  repoMetricsMetadata,
  repoPauseMetadata,
  repoResumeMetadata,
  repoSyncMetadata,
  graphNodeListMetadata,
  graphStatsMetadata,
  integrationConfigureMetadata,
  integrationDeleteMetadata,
  integrationGetMetadata,
  integrationInstallMetadata,
  integrationListMetadata,
  integrationMetricsMetadata,
  integrationSyncMetadata,
  ontologyQueryMetadata,
  ontologyNeighborsMetadata,
  agentComposeMetadata,
  agentSubagentCancelMetadata,
  agentSubagentLogsMetadata,
  apiKeyRotateMetadata,
  auditLogQueryMetadata,
  automationUpdateMetadata,
  connectionPauseMetadata,
  connectionUpdateMetadata,
  graphIngestMetadata,
  orgSettingsReadMetadata,
  orgSettingsWriteMetadata,
  workspaceSettingsReadMetadata,
  workspaceSettingsWriteMetadata,
  markdownGenerateMetadata,
  mermaidGenerateMetadata,
  conversationFilesListMetadata,
  agentMcpConsentResolveMetadata,
  agentMcpConsentListMetadata,
  agentMcpSetEnabledMetadata,
  agentMcpDeleteMetadata,
  skillWorkspaceInstallMetadata,
  skillVersionListMetadata,
  skillVersionGetMetadata,
  skillVersionUploadMetadata,
  skillVersionActivateMetadata,
  skillEditMetadata,
  skillExportMetadata,
  skillMetricsReadMetadata,
  skillAuthorMetadata,
  skillCreateMetadata,
  skillEnableMetadata,
  graphRelationshipUpsertMetadata,
  schemaExportMetadata,
  schemaLabelDeleteMetadata,
  schemaLabelUpsertMetadata,
  schemaListMetadata,
  schemaPropertyDeleteMetadata,
  schemaPropertyUpsertMetadata,
  schemaRecommendMetadata,
  schemaReconcileDispatchMetadata,
  schemaReconcileStatusMetadata,
  schemaRegistryConfigMetadata,
  schemaRegistryGetMetadata,
  schemaRelationshipDeleteMetadata,
  schemaRelationshipUpsertMetadata,
  schemaSetupMetadata,
  schemaToggleMetadata,
  schemaValidateNodeMetadata,
  schemaValidateRelationshipMetadata,
  schemaVersionCreateMetadata,
  schemaVersionDiffMetadata,
  schemaVersionListMetadata,
  schemaVersionPinMetadata,
  semanticRelationshipApproveMetadata,
  semanticRelationshipInferMetadata,
  semanticRelationshipListMetadata,
  semanticRelationshipSuggestMetadata,
  environmentCreateMetadata,
  environmentListMetadata,
  environmentGetMetadata,
  environmentUpdateMetadata,
  environmentDeleteMetadata,
  environmentSetDefaultMetadata,
  secretKeyUpsertMetadata,
  secretKeyListMetadata,
  secretKeyDeleteMetadata,
  secretValueSetMetadata,
  secretValueUnsetMetadata,
  secretImportEnvMetadata,
  secretRevealMetadata,
  secretExportMetadata,
  // Code capability tools (mcp-surfaced; tool files existed but weren't listed here)
  codeDiffMetadata,
  codePatchMetadata,
  codeFormatMetadata,
  // Memory decay policy tools (OXA-1374)
  agentMemoryPolicyReadMetadata,
  agentMemoryPolicyWriteMetadata,
  // Memory CRUD
  agentMemoryDeleteMetadata,
  agentMemoryRememberMetadata,
  agentMemoryUpdateMetadata,
  // Memory import
  agentMemoryImportCommitMetadata,
  agentMemoryImportParseMetadata,
  // Agent feature verification
  agentFeatureVerifyMetadata,
  // Sandbox lifecycle
  agentSandboxExecMetadata,
  agentSandboxSnapshotMetadata,
  agentSandboxStartMetadata,
  agentSandboxStopMetadata,
  // Browser automation
  browserClickMetadata,
  browserFillMetadata,
  browserNavigateMetadata,
  browserReadMetadata,
  browserRefreshMetadata,
  browserScreenshotMetadata,
  browserSubmitMetadata,
  // Code-map retrieval
  codeMapMetadata,
  // Graph sync push
  graphSyncPushMetadata,
];

// ── Derive expected tool set from contracts ───────────────────────────────────

/** Names derived from the contracts array for the "mcp" surface (sorted). */
const contractMcpNames = (
  contracts as ReadonlyArray<{ name: string; surfaces: readonly string[] }>
)
  .filter((c) => c.surfaces.includes("mcp"))
  .map((c) => c.name)
  .sort();

/** Names as declared in the tool metadata (sorted). */
const registeredToolNames = allToolMetadata.map((m) => m.name).sort();

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("tool-registry parity", () => {
  it("registered tool names match the mcp-surfaced contracts exactly", () => {
    expect(registeredToolNames).toEqual(contractMcpNames);
  });

  it("each tool metadata.name matches the corresponding contract name (no copy-paste drift)", () => {
    // Build a map: contract name -> contract for O(1) lookup.
    const contractByName = new Map(
      (
        contracts as ReadonlyArray<{
          name: string;
          surfaces: readonly string[];
        }>
      )
        .filter((c) => c.surfaces.includes("mcp"))
        .map((c) => [c.name, c]),
    );

    for (const meta of allToolMetadata) {
      const contract = contractByName.get(meta.name);
      expect(
        contract,
        `Tool metadata has name "${meta.name}" but no matching mcp-surfaced contract exists`,
      ).toBeDefined();
      expect(meta.name).toBe(contract!.name);
    }
  });

  it("no two tool files declare the same metadata.name", () => {
    const nameSet = new Set<string>();
    for (const meta of allToolMetadata) {
      expect(
        nameSet.has(meta.name),
        `Duplicate tool metadata name: "${meta.name}"`,
      ).toBe(false);
      nameSet.add(meta.name);
    }
  });

  it("has at least one registered tool (sanity: registry is non-empty)", () => {
    expect(allToolMetadata.length).toBeGreaterThan(0);
  });
});

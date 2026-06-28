import { Hono } from "hono";
import type { CapabilityContext } from "@oxagen/oxagen";
import { requestLogger } from "./middleware/logger";
import { corsMiddleware } from "./middleware/cors";
import { errorMiddleware } from "./middleware/error";
import { authMiddleware } from "./middleware/auth";
import { orgMiddleware } from "./middleware/org";
import { workspaceMiddleware } from "./middleware/workspace";
import { health } from "./routes/health";
import { stripeWebhook } from "./routes/stripe";
import { inngestRoute } from "./routes/inngest";
import { organizationCreateRoute } from "./routes/v1/organization.create";
import { workspaceCreateRoute } from "./routes/v1/workspace.create";
import { billingSubscriptionReadRoute } from "./routes/v1/billing.subscription.read";
import { billingSubscriptionUpgradeStartRoute } from "./routes/v1/billing.subscription.upgrade.start";
import { billingCreditsPurchaseRoute } from "./routes/v1/billing.credits.purchase";
import { chatMessageSendRoute } from "./routes/v1/chat.message.send";
import { chatMessageExecutionRoute } from "./routes/v1/chat.message.execution";
import { chatStreamRoute } from "./routes/v1/chat.stream";
import { agentCodeExecuteRoute } from "./routes/v1/agent.code.execute";
import { codeDiffRoute } from "./routes/v1/code.diff";
import { codePatchRoute } from "./routes/v1/code.patch";
import { codeFormatRoute } from "./routes/v1/code.format";
import { agentToolListRoute } from "./routes/v1/agent.tool.list";
import { agentMcpRegisterRoute } from "./routes/v1/agent.mcp.register";
import { agentMcpListRoute } from "./routes/v1/agent.mcp.list";
import { agentMcpSetEnabledRoute } from "./routes/v1/agent.mcp.set_enabled";
import { agentMcpDeleteRoute } from "./routes/v1/agent.mcp.delete";
import { agentMcpConsentResolveRoute } from "./routes/v1/agent.mcp.consent.resolve";
import { agentMcpConsentListRoute } from "./routes/v1/agent.mcp.consent.list";
import { agentSkillListRoute } from "./routes/v1/agent.skill.list";
import { agentSkillLoadRoute } from "./routes/v1/agent.skill.load";
import { agentPlanApproveRoute } from "./routes/v1/agent.plan.approve";
import { agentPlanCreateRoute } from "./routes/v1/agent.plan.create";
import { agentComposeRoute } from "./routes/v1/agent.compose";
import { agentSubagentLogsRoute } from "./routes/v1/agent.subagent.logs";
import { agentTaskBackgroundStartRoute } from "./routes/v1/agent.task.background.start";
import { agentTaskBackgroundReadRoute } from "./routes/v1/agent.task.background.read";
import { agentTaskBackgroundCancelRoute } from "./routes/v1/agent.task.background.cancel";
import { agentMemoryRecallRoute } from "./routes/v1/agent.memory.recall";
import { agentMemoryWriteRoute } from "./routes/v1/agent.memory.write";
import { agentMemoryListRoute } from "./routes/v1/agent.memory.list";
import { agentMemoryPolicyReadRoute } from "./routes/v1/agent.memory.policy.read";
import { agentMemoryPolicyWriteRoute } from "./routes/v1/agent.memory.policy.write";
import { agentApprovalResolveRoute } from "./routes/v1/agent.approval.resolve";
import { agentExecutionRecordRoute } from "./routes/v1/agent.execution.record";
import { agentSubagentAggregateRoute } from "./routes/v1/agent.subagent.aggregate";
import { agentSubagentFanoutListRoute } from "./routes/v1/agent.subagent.fanout.list";
import { agentSubagentFanoutGetRoute } from "./routes/v1/agent.subagent.fanout.get";
import { formFillRoute } from "./routes/v1/form.fill";
import { commandMenuSearchRoute } from "./routes/v1/command.menu.search";
import { commandMenuSuggestRoute } from "./routes/v1/command.menu.suggest";
import { archiveCreateRoute } from "./routes/v1/archive.create";
import { documentsGenerateRoute } from "./routes/v1/documents.generate";
import { documentsPdfCreateRoute } from "./routes/v1/documents.pdf.create";
import { markdownGenerateRoute } from "./routes/v1/markdown.generate";
import { mermaidGenerateRoute } from "./routes/v1/mermaid.generate";
import { videoGenerateRoute } from "./routes/v1/video.generate";
import { svgGenerateRoute } from "./routes/v1/svg.generate";
import { imageGenerateRoute } from "./routes/v1/image.generate";
import { systemInstallInstructionsRoute } from "./routes/v1/system.install.instructions";
import { orgMemberAddRoute } from "./routes/v1/org.member.add";
import { orgMemberInviteAcceptRoute } from "./routes/v1/org.member.invite.accept";
import { orgMemberInviteDeclineRoute } from "./routes/v1/org.member.invite.decline";
import { orgMemberRemoveRoute } from "./routes/v1/org.member.remove";
import { orgMemberRoleChangeRoute } from "./routes/v1/org.member.role.change";
import { userPreferencesReadRoute } from "./routes/v1/user.preferences.read";
import { userPreferencesWriteRoute } from "./routes/v1/user.preferences.write";
import { workspaceModelSettingsReadRoute } from "./routes/v1/workspace.model.settings.read";
import { workspaceModelSettingsWriteRoute } from "./routes/v1/workspace.model.settings.write";
import { promptSettingsReadRoute } from "./routes/v1/prompt.settings.read";
import { promptSettingsWriteRoute } from "./routes/v1/prompt.settings.write";
import { orgSettingsReadRoute } from "./routes/v1/org.settings.read";
import { orgSettingsWriteRoute } from "./routes/v1/org.settings.write";
import { workspaceSettingsReadRoute } from "./routes/v1/workspace.settings.read";
import { workspaceSettingsWriteRoute } from "./routes/v1/workspace.settings.write";
import { conversationListRoute } from "./routes/v1/conversation.list";
import { conversationRenameRoute } from "./routes/v1/conversation.rename";
import { conversationArchiveRoute } from "./routes/v1/conversation.archive";
import { conversationDeleteRoute } from "./routes/v1/conversation.delete";
import { conversationPurgeRoute } from "./routes/v1/conversation.purge";
import { conversationFilesListRoute } from "./routes/v1/conversation.files.list";
import { assetUploadRoute } from "./routes/v1/asset.upload";
import { pluginRegistryListRoute } from "./routes/v1/plugin.registry.list";
import { pluginRegistryAddRoute } from "./routes/v1/plugin.registry.add";
import { pluginRegistryRemoveRoute } from "./routes/v1/plugin.registry.remove";
import { pluginCatalogBrowseRoute } from "./routes/v1/plugin.catalog.browse";
import { pluginCatalogGetRoute } from "./routes/v1/plugin.catalog.get";
import { pluginCatalogSyncRoute } from "./routes/v1/plugin.catalog.sync";
import { pluginOrgListRoute } from "./routes/v1/plugin.org.list";
import { pluginOrgInstallRoute } from "./routes/v1/plugin.org.install";
import { pluginOrgInstallBulkRoute } from "./routes/v1/plugin.org.install_bulk";
import { pluginOrgUninstallRoute } from "./routes/v1/plugin.org.uninstall";
import { pluginOrgSetEnabledRoute } from "./routes/v1/plugin.org.set_enabled";
import { pluginWorkspaceSetEnabledRoute } from "./routes/v1/plugin.workspace.set_enabled";
import { pluginCredentialSetSecretRoute } from "./routes/v1/plugin.credential.set_secret";
import { pluginCredentialReauthRoute } from "./routes/v1/plugin.credential.reauth";
// Environments + credential vault (Spec: 2026-06-24-credential-vault-…).
import { environmentCreateRoute } from "./routes/v1/environment.create";
import { environmentListRoute } from "./routes/v1/environment.list";
import { environmentGetRoute } from "./routes/v1/environment.get";
import { environmentUpdateRoute } from "./routes/v1/environment.update";
import { environmentDeleteRoute } from "./routes/v1/environment.delete";
import { environmentSetDefaultRoute } from "./routes/v1/environment.set_default";
import { secretKeyUpsertRoute } from "./routes/v1/secret.key.upsert";
import { secretKeyListRoute } from "./routes/v1/secret.key.list";
import { secretKeyDeleteRoute } from "./routes/v1/secret.key.delete";
import { secretValueSetRoute } from "./routes/v1/secret.value.set";
import { secretValueUnsetRoute } from "./routes/v1/secret.value.unset";
import { secretImportEnvRoute } from "./routes/v1/secret.import_env";
import { secretRevealRoute } from "./routes/v1/secret.reveal";
import { secretExportRoute } from "./routes/v1/secret.export";
import { notificationsListRoute } from "./routes/v1/notifications.list";
import { notificationsMarkRoute } from "./routes/v1/notifications.mark";
import { pluginSettingsSetAuthAlertsRoute } from "./routes/v1/plugin.settings.set_auth_alerts";
import { apiKeyCreateRoute } from "./routes/v1/api.key.create";
import { apiKeyRevokeRoute } from "./routes/v1/api.key.revoke";
import { apiKeyRotateRoute } from "./routes/v1/api.key.rotate";
import { workflowRoute } from "./routes/v1/workflow";
import { workspaceMemberListRoute } from "./routes/v1/workspace.member.list";
import { workspaceInviteSendRoute } from "./routes/v1/workspace.invite.send";
import { conversationChatRoute } from "./routes/v1/conversation.chat";
import { imageCreateRoute } from "./routes/v1/image.create";
import { imageListRoute } from "./routes/v1/image.list";
import { imageAnalyzeRoute } from "./routes/v1/image.analyze";
import { documentCreateRoute } from "./routes/v1/document.create";
import { documentListRoute } from "./routes/v1/document.list";
import { documentReadRoute } from "./routes/v1/document.read";
import { automationListRoute } from "./routes/v1/automation.list";
import { automationCreateRoute } from "./routes/v1/automation.create";
import { automationUpdateRoute } from "./routes/v1/automation.update";
import { automationEnableRoute } from "./routes/v1/automation.enable";
import { automationDisableRoute } from "./routes/v1/automation.disable";
import { automationTriggerRoute } from "./routes/v1/automation.trigger";
import { skillWorkspaceListRoute } from "./routes/v1/skill.workspace.list";
import { skillWorkspaceInstallRoute } from "./routes/v1/skill.workspace.install";
import { skillVersionListRoute } from "./routes/v1/skill.version.list";
import { skillVersionGetRoute } from "./routes/v1/skill.version.get";
import { skillVersionUploadRoute } from "./routes/v1/skill.version.upload";
import { skillVersionActivateRoute } from "./routes/v1/skill.version.activate";
import { skillEditRoute } from "./routes/v1/skill.edit";
import { skillExportRoute } from "./routes/v1/skill.export";
import { skillMetricsReadRoute } from "./routes/v1/skill.metrics.read";
import { skillAuthorRoute } from "./routes/v1/skill.author";
import { skillCreateRoute } from "./routes/v1/skill.create";
import { skillEnableRoute } from "./routes/v1/skill.enable";
import { agentSubagentCancelRoute } from "./routes/v1/agent.subagent.cancel";
import { agentSubagentDispatchRoute } from "./routes/v1/agent.subagent.dispatch";
import { agentDefinitionCreateRoute } from "./routes/v1/agent.definition.create";
import { agentDefinitionUpdateRoute } from "./routes/v1/agent.definition.update";
import { agentDefinitionPublishRoute } from "./routes/v1/agent.definition.publish";
import { agentDefinitionGetRoute } from "./routes/v1/agent.definition.get";
import { agentDefinitionListRoute } from "./routes/v1/agent.definition.list";
import { agentDeployRoute } from "./routes/v1/agent.deploy";
import { agentTriggerCreateRoute } from "./routes/v1/agent.trigger.create";
import { agentTriggerUpdateRoute } from "./routes/v1/agent.trigger.update";
import { agentTriggerDeleteRoute } from "./routes/v1/agent.trigger.delete";
import { agentTriggerListRoute } from "./routes/v1/agent.trigger.list";
import { privacyDataExportRoute } from "./routes/v1/privacy.data.export";
import { privacyDataEraseRoute } from "./routes/v1/privacy.data.erase";
import { connectionRoute } from "./routes/v1/connection";
import { webhookRoute } from "./routes/v1/webhook";
import {
  githubOauthRoute,
  githubOauthCallbackRoute,
} from "./routes/v1/github-oauth";
import { githubAppWebhookRoute } from "./routes/v1/github-webhook";
import { graphNodeUpsertRoute } from "./routes/v1/graph.node.upsert";
import { graphNodeGetRoute } from "./routes/v1/graph.node.get";
import { graphNodeDeleteRoute } from "./routes/v1/graph.node.delete";
import { graphNodeSearchRoute } from "./routes/v1/graph.node.search";
import { graphSearchRoute } from "./routes/v1/graph.search";
import { graphEdgeUpsertRoute } from "./routes/v1/graph.edge.upsert";
import { graphEdgeDeleteRoute } from "./routes/v1/graph.edge.delete";
import { graphCypherRoute } from "./routes/v1/graph.cypher";
import { graphIngestRoute } from "./routes/v1/graph.ingest";
import { webSearchRoute } from "./routes/v1/web.search";
import { webFetchRoute } from "./routes/v1/web.fetch";
import { researchSwarmStartRoute } from "./routes/v1/research.swarm.start";
import { researchSwarmStatusRoute } from "./routes/v1/research.swarm.status";
import { semanticEdgeRoute } from "./routes/v1/semantic-edge";
import { repoRoute } from "./routes/v1/repo";
import { integrationRoute } from "./routes/v1/integration";
import { schemaRoute } from "./routes/v1/schema";
import { semanticRelationshipRoute } from "./routes/v1/semantic-relationship";
import { graphRelationshipUpsertRoute } from "./routes/v1/graph.relationship.upsert";
import {
  pluginSchemaRoute,
  pluginVersionRoute,
} from "./routes/v1/plugin-schema";
import { graphNodeListRoute } from "./routes/v1/graph.node.list";
import { graphExportRoute } from "./routes/v1/graph.export";
import { graphSyncPushRoute } from "./routes/v1/graph.sync.push";
import { graphStatsRoute } from "./routes/v1/graph.stats";
import { ontologyQueryRoute } from "./routes/v1/ontology.query";
import { ontologyNeighborsRoute } from "./routes/v1/ontology.neighbors";
import { auditLogQueryRoute } from "./routes/v1/audit.log.query";

export type AppEnv = {
  Variables: {
    requestId: string;
    userId: string | null;
    apiKeyId: string | null;
    orgId: string | null;
    workspaceId: string | null;
    capabilityContext?: CapabilityContext;
  };
};

export const app = new Hono<AppEnv>();

app.use("*", requestLogger);
// CORS must run before auth: a preflight OPTIONS carries no credentials, so
// it has to short-circuit here or the browser never sends the real request.
app.use("*", corsMiddleware);
app.onError(errorMiddleware);

// Public routes — health and Stripe webhook bypass auth. The webhook needs
// the raw body for signature verification and is its own auth surface.
app.route("/health", health);
app.route("/webhooks/stripe", stripeWebhook);
// GitHub App webhook: single global URL, resolves connections from the payload's
// installation id. Mounted BEFORE the generic /webhooks route so "/webhooks/github/app"
// is not captured as connectorId=github, connectionId=app.
app.route("/webhooks/github/app", githubAppWebhookRoute);
// Connector webhooks: unauthenticated — HMAC validation is the security boundary.
app.route("/webhooks", webhookRoute);
// Inngest cloud polls /api/inngest for the function manifest; signing-key
// verification is enforced inside the inngest/hono serve handler.
app.route("/api/inngest", inngestRoute);

// /v1 user-level routes (org + workspace CRUD) require auth but no
// org scope: a freshly-authenticated user can create their first
// org without one existing.
const userScoped = new Hono<AppEnv>();
userScoped.use("*", authMiddleware);
userScoped.route("/organizations", organizationCreateRoute);
userScoped.route("/user/preferences/read", userPreferencesReadRoute);
userScoped.route("/user/preferences/write", userPreferencesWriteRoute);
app.route("/v1", userScoped);

// /v1/:org_slug/:workspace_slug/* — org + workspace scoped routes.
const orgScoped = new Hono<AppEnv>();
orgScoped.use("*", authMiddleware, orgMiddleware, workspaceMiddleware);
orgScoped.route("/workspaces", workspaceCreateRoute);
orgScoped.route("/billing/subscription", billingSubscriptionReadRoute);
orgScoped.route(
  "/billing/subscription/upgrade/start",
  billingSubscriptionUpgradeStartRoute,
);
orgScoped.route("/billing/credits/purchase", billingCreditsPurchaseRoute);
orgScoped.route("/chat/messages", chatMessageSendRoute);
orgScoped.route("/chat/messages/execution", chatMessageExecutionRoute);
orgScoped.route("/chat/stream", chatStreamRoute);
orgScoped.route("/conversations", conversationListRoute);
// GET /conversations/:conversationId/files — registered at the same prefix as the
// list route; Hono dispatches by method+full path so it does not clash with the
// bare GET /conversations list or the /conversations/{rename,archive,…} sub-paths.
orgScoped.route("/conversations", conversationFilesListRoute);
orgScoped.route("/conversations/rename", conversationRenameRoute);
orgScoped.route("/conversations/archive", conversationArchiveRoute);
orgScoped.route("/conversations/delete", conversationDeleteRoute);
orgScoped.route("/conversations/purge", conversationPurgeRoute);
// Agent-runtime routes live under the org + workspace scope so the runner
// inherits the same auth, isolation, and audit envelope as every other v1 call.
orgScoped.route("/agent/code/execute", agentCodeExecuteRoute);
// Code-execution surface peers (OXA-1352) under the same org+workspace scope.
orgScoped.route("/code/diff", codeDiffRoute);
orgScoped.route("/code/patch", codePatchRoute);
orgScoped.route("/code/format", codeFormatRoute);
orgScoped.route("/agent/tools", agentToolListRoute);
orgScoped.route("/agent/mcp-servers", agentMcpRegisterRoute);
orgScoped.route("/agent/mcp-servers", agentMcpListRoute);
orgScoped.route("/agent/mcp-servers/set-enabled", agentMcpSetEnabledRoute);
orgScoped.route("/agent/mcp-servers/delete", agentMcpDeleteRoute);
orgScoped.route("/agent/mcp-consents/resolve", agentMcpConsentResolveRoute);
orgScoped.route("/agent/mcp-consents", agentMcpConsentListRoute);
orgScoped.route("/agent/skills", agentSkillListRoute);
orgScoped.route("/agent/skills/load", agentSkillLoadRoute);
orgScoped.route("/agent/plans/approve", agentPlanApproveRoute);
orgScoped.route("/agent/plans", agentPlanCreateRoute);
orgScoped.route("/agent/compose", agentComposeRoute);
orgScoped.route("/agent/subagent/logs", agentSubagentLogsRoute);
orgScoped.route("/agent/tasks", agentTaskBackgroundStartRoute);
orgScoped.route("/agent/tasks", agentTaskBackgroundReadRoute);
orgScoped.route("/agent/tasks/cancel", agentTaskBackgroundCancelRoute);
orgScoped.route("/agent/memory/recall", agentMemoryRecallRoute);
orgScoped.route("/agent/memory/list", agentMemoryListRoute);
orgScoped.route("/agent/memory/policy", agentMemoryPolicyReadRoute);
orgScoped.route("/agent/memory/policy", agentMemoryPolicyWriteRoute);
orgScoped.route("/agent/memory", agentMemoryWriteRoute);
orgScoped.route("/agent/approvals/resolve", agentApprovalResolveRoute);
orgScoped.route("/agent/execution/record", agentExecutionRecordRoute);
orgScoped.route("/agent/subagent/aggregate", agentSubagentAggregateRoute);
orgScoped.route("/agent/subagent/cancel", agentSubagentCancelRoute);
orgScoped.route("/agent/subagent/dispatch", agentSubagentDispatchRoute);
// Read side of the fan-out feature: list fan-outs, then get one with child runs.
orgScoped.route("/agent/subagent/fanouts", agentSubagentFanoutListRoute);
orgScoped.route("/agent/subagent/fanout", agentSubagentFanoutGetRoute);
// Agent lifecycle: definitions, deployment, triggers. The /update and /publish
// sub-paths are mounted before the get route so they are not swallowed by its
// GET /:agentId param match.
orgScoped.route("/agent/definitions/update", agentDefinitionUpdateRoute);
orgScoped.route("/agent/definitions/publish", agentDefinitionPublishRoute);
orgScoped.route("/agent/definitions", agentDefinitionCreateRoute);
orgScoped.route("/agent/definitions", agentDefinitionListRoute);
orgScoped.route("/agent/definitions", agentDefinitionGetRoute);
orgScoped.route("/agent/deploy", agentDeployRoute);
orgScoped.route("/agent/triggers/update", agentTriggerUpdateRoute);
orgScoped.route("/agent/triggers/delete", agentTriggerDeleteRoute);
orgScoped.route("/agent/triggers", agentTriggerCreateRoute);
orgScoped.route("/agent/triggers", agentTriggerListRoute);
orgScoped.route("/forms/fill", formFillRoute);
orgScoped.route("/command/menu/search", commandMenuSearchRoute);
orgScoped.route("/command/menu/suggest", commandMenuSuggestRoute);
orgScoped.route("/archive/create", archiveCreateRoute);
orgScoped.route("/documents/generate", documentsGenerateRoute);
orgScoped.route("/documents/pdf", documentsPdfCreateRoute);
orgScoped.route("/markdown/generate", markdownGenerateRoute);
orgScoped.route("/mermaid/generate", mermaidGenerateRoute);
orgScoped.route("/video/generate", videoGenerateRoute);
orgScoped.route("/svg/generate", svgGenerateRoute);
orgScoped.route("/image/generate", imageGenerateRoute);
orgScoped.route("/system/install-instructions", systemInstallInstructionsRoute);
orgScoped.route("/org/members", orgMemberAddRoute);
orgScoped.route("/org/members/remove", orgMemberRemoveRoute);
orgScoped.route("/org/members/role", orgMemberRoleChangeRoute);
orgScoped.route("/org/invitations/accept", orgMemberInviteAcceptRoute);
orgScoped.route("/org/invitations/decline", orgMemberInviteDeclineRoute);
orgScoped.route("/workspace/model-settings", workspaceModelSettingsReadRoute);
orgScoped.route("/workspace/model-settings", workspaceModelSettingsWriteRoute);
orgScoped.route("/workspace/prompt-settings", promptSettingsReadRoute);
orgScoped.route("/workspace/prompt-settings", promptSettingsWriteRoute);
orgScoped.route("/org/settings", orgSettingsReadRoute);
orgScoped.route("/org/settings", orgSettingsWriteRoute);
orgScoped.route("/workspace/settings", workspaceSettingsReadRoute);
orgScoped.route("/workspace/settings", workspaceSettingsWriteRoute);
orgScoped.route("/asset/upload", assetUploadRoute);
orgScoped.route("/plugin/registries", pluginRegistryListRoute);
orgScoped.route("/plugin/registries/add", pluginRegistryAddRoute);
orgScoped.route("/plugin/registries/remove", pluginRegistryRemoveRoute);
orgScoped.route("/plugin/catalog/browse", pluginCatalogBrowseRoute);
orgScoped.route("/plugin/catalog/get", pluginCatalogGetRoute);
orgScoped.route("/plugin/catalog/sync", pluginCatalogSyncRoute);
orgScoped.route("/plugin/org/list", pluginOrgListRoute);
orgScoped.route("/plugin/org/install", pluginOrgInstallRoute);
orgScoped.route("/plugin/org/install-bulk", pluginOrgInstallBulkRoute);
orgScoped.route("/plugin/org/uninstall", pluginOrgUninstallRoute);
orgScoped.route("/plugin/org/set-enabled", pluginOrgSetEnabledRoute);
orgScoped.route(
  "/plugin/workspace/set-enabled",
  pluginWorkspaceSetEnabledRoute,
);
orgScoped.route(
  "/plugin/credential/set-secret",
  pluginCredentialSetSecretRoute,
);
orgScoped.route("/plugin/credential/reauth", pluginCredentialReauthRoute);
// Environments + credential vault.
orgScoped.route("/environment/create", environmentCreateRoute);
orgScoped.route("/environment/list", environmentListRoute);
orgScoped.route("/environment/get", environmentGetRoute);
orgScoped.route("/environment/update", environmentUpdateRoute);
orgScoped.route("/environment/delete", environmentDeleteRoute);
orgScoped.route("/environment/set-default", environmentSetDefaultRoute);
orgScoped.route("/secret/key/upsert", secretKeyUpsertRoute);
orgScoped.route("/secret/key/list", secretKeyListRoute);
orgScoped.route("/secret/key/delete", secretKeyDeleteRoute);
orgScoped.route("/secret/value/set", secretValueSetRoute);
orgScoped.route("/secret/value/unset", secretValueUnsetRoute);
orgScoped.route("/secret/import-env", secretImportEnvRoute);
orgScoped.route("/secret/reveal", secretRevealRoute);
orgScoped.route("/secret/export", secretExportRoute);
orgScoped.route("/notifications", notificationsListRoute);
orgScoped.route("/notifications/mark", notificationsMarkRoute);
orgScoped.route(
  "/plugin/settings/auth-alerts",
  pluginSettingsSetAuthAlertsRoute,
);
orgScoped.route("/api-keys", apiKeyCreateRoute);
orgScoped.route("/api-keys/revoke", apiKeyRevokeRoute);
orgScoped.route("/api-keys/rotate", apiKeyRotateRoute);
orgScoped.route("/workflows", workflowRoute);
orgScoped.route("/workspace/member/list", workspaceMemberListRoute);
orgScoped.route("/workspace/invite/send", workspaceInviteSendRoute);
orgScoped.route("/conversation/chat", conversationChatRoute);
orgScoped.route("/image/create", imageCreateRoute);
orgScoped.route("/image/list", imageListRoute);
orgScoped.route("/image/analyze", imageAnalyzeRoute);
orgScoped.route("/document/create", documentCreateRoute);
orgScoped.route("/document/list", documentListRoute);
orgScoped.route("/document/read", documentReadRoute);
orgScoped.route("/automation/list", automationListRoute);
orgScoped.route("/automation/create", automationCreateRoute);
orgScoped.route("/automation/update", automationUpdateRoute);
orgScoped.route("/automation/enable", automationEnableRoute);
orgScoped.route("/automation/disable", automationDisableRoute);
orgScoped.route("/automation/trigger", automationTriggerRoute);
orgScoped.route("/skill/workspace/list", skillWorkspaceListRoute);
orgScoped.route("/skill/workspace/install", skillWorkspaceInstallRoute);
orgScoped.route("/skill/version/list", skillVersionListRoute);
orgScoped.route("/skill/version/get", skillVersionGetRoute);
orgScoped.route("/skill/version/upload", skillVersionUploadRoute);
orgScoped.route("/skill/version/activate", skillVersionActivateRoute);
orgScoped.route("/skill/edit", skillEditRoute);
orgScoped.route("/skill/export", skillExportRoute);
orgScoped.route("/skill/metrics/read", skillMetricsReadRoute);
orgScoped.route("/skill/author", skillAuthorRoute);
orgScoped.route("/skill/create", skillCreateRoute);
orgScoped.route("/skill/enable", skillEnableRoute);
orgScoped.route("/privacy/export", privacyDataExportRoute);
orgScoped.route("/privacy/erase", privacyDataEraseRoute);
orgScoped.route("/connections", connectionRoute);
// GitHub App OAuth endpoints (workspace-scoped + auth-required)
orgScoped.route("/connections/github", githubOauthRoute);
orgScoped.route("/graph/node/upsert", graphNodeUpsertRoute);
orgScoped.route("/graph/node/get", graphNodeGetRoute);
orgScoped.route("/graph/node/delete", graphNodeDeleteRoute);
orgScoped.route("/graph/node/search", graphNodeSearchRoute);
orgScoped.route("/graph/search", graphSearchRoute);
orgScoped.route("/graph/edge/upsert", graphEdgeUpsertRoute);
orgScoped.route("/graph/edge/delete", graphEdgeDeleteRoute);
orgScoped.route("/graph/cypher", graphCypherRoute);
orgScoped.route("/graph/ingest", graphIngestRoute);
orgScoped.route("/web/search", webSearchRoute);
orgScoped.route("/web/fetch", webFetchRoute);
orgScoped.route("/research/swarm/start", researchSwarmStartRoute);
orgScoped.route("/research/swarm/status", researchSwarmStatusRoute);
orgScoped.route("/semantic-edges", semanticEdgeRoute);
orgScoped.route("/repos", repoRoute);
orgScoped.route("/integrations", integrationRoute);
orgScoped.route("/schema", schemaRoute);
// Canonical semantic.relationship.* routes (semantic-edge.ts at /semantic-edges
// remains a deprecation alias during the rename window).
orgScoped.route("/semantic-relationships", semanticRelationshipRoute);
// graph.relationship.upsert (canonical) — /graph/edge/upsert stays as alias.
orgScoped.route("/graph/relationship/upsert", graphRelationshipUpsertRoute);
orgScoped.route("/plugin-schema", pluginSchemaRoute);
orgScoped.route("/plugin-versions", pluginVersionRoute);
orgScoped.route("/graph/nodes", graphNodeListRoute);
orgScoped.route("/graph/export", graphExportRoute);
orgScoped.route("/graph/sync/push", graphSyncPushRoute);
orgScoped.route("/graph/stats", graphStatsRoute);
orgScoped.route("/ontology/query", ontologyQueryRoute);
orgScoped.route("/ontology/neighbors", ontologyNeighborsRoute);
orgScoped.route("/audit/log/query", auditLogQueryRoute);
app.route("/v1/:org_slug/:workspace_slug", orgScoped);

// Public OAuth callback — HMAC-verified state param is the security boundary.
// Must NOT be inside the workspace-scoped group (user has no session when GitHub redirects).
app.route("/oauth/github", githubOauthCallbackRoute);

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
import { organizationCreateRoute } from "./routes/v1/org.create";
import { workspaceCreateRoute } from "./routes/v1/workspace.create";
import { orgListRoute } from "./routes/v1/org.list";
import { workspaceListRoute } from "./routes/v1/workspace.list";
import { billingSubscriptionReadRoute } from "./routes/v1/billing.subscription.read";
import { billingUsageBreakdownRoute } from "./routes/v1/billing.usage.breakdown";
import { billingSubscriptionUpgradeStartRoute } from "./routes/v1/billing.subscription_upgrade.start";
import { billingCreditsPurchaseRoute } from "./routes/v1/billing.credits.purchase";
import { chatMessageSendRoute } from "./routes/v1/chat.message.send";
import { chatMessageExecutionRoute } from "./routes/v1/chat.message.execution";
import { chatStreamRoute } from "./routes/v1/chat.stream";
import { agentCodeExecuteRoute } from "./routes/v1/agent.code.execute";
import { agentSandboxStartRoute } from "./routes/v1/agent.sandbox.start";
import { agentSandboxExecRoute } from "./routes/v1/agent.sandbox.exec";
import { agentSandboxSnapshotRoute } from "./routes/v1/agent.sandbox.snapshot";
import { agentSandboxStopRoute } from "./routes/v1/agent.sandbox.stop";
import { agentSandboxFilesListRoute } from "./routes/v1/agent.sandbox_file.list";
import { agentFeatureVerifyRoute } from "./routes/v1/agent.feature.verify";
import { browserNavigateRoute } from "./routes/v1/browser.navigate";
import { browserScreenshotRoute } from "./routes/v1/browser.screenshot";
import { browserFillRoute } from "./routes/v1/browser.fill";
import { browserSubmitRoute } from "./routes/v1/browser.submit";
import { browserClickRoute } from "./routes/v1/browser.click";
import { browserRefreshRoute } from "./routes/v1/browser.refresh";
import { browserReadRoute } from "./routes/v1/browser.read";
import { codeDiffRoute } from "./routes/v1/code.diff";
import { codePatchRoute } from "./routes/v1/code.patch";
import { codeFormatRoute } from "./routes/v1/code.format";
import { codeMapRoute } from "./routes/v1/code.map";
import { agentToolListRoute } from "./routes/v1/agent.tool.list";
import { agentMcpRegisterRoute } from "./routes/v1/agent.mcp.register";
import { agentMcpListRoute } from "./routes/v1/agent.mcp.list";
import { agentMcpSetEnabledRoute } from "./routes/v1/agent.mcp.set_enabled";
import { agentMcpDeleteRoute } from "./routes/v1/agent.mcp.delete";
import { agentMcpConsentResolveRoute } from "./routes/v1/agent.mcp_consent.resolve";
import { agentMcpConsentListRoute } from "./routes/v1/agent.mcp_consent.list";
import { agentSkillListRoute } from "./routes/v1/agent.skill.list";
import { agentSkillLoadRoute } from "./routes/v1/agent.skill.load";
import { agentPlanApproveRoute } from "./routes/v1/agent.plan.approve";
import { agentPlanCreateRoute } from "./routes/v1/agent.plan.create";
import { agentComposeRoute } from "./routes/v1/agent.compose";
import { agentSubagentLogsRoute } from "./routes/v1/agent.subagent.logs";
import { agentTaskBackgroundStartRoute } from "./routes/v1/agent.background_task.start";
import { agentTaskBackgroundReadRoute } from "./routes/v1/agent.background_task.read";
import { agentTaskBackgroundCancelRoute } from "./routes/v1/agent.background_task.cancel";
import { agentMemoryRecallRoute } from "./routes/v1/agent.memory.recall";
import { agentMemoryWriteRoute } from "./routes/v1/agent.memory.write";
import { agentMemoryListRoute } from "./routes/v1/agent.memory.list";
import { agentMemoryUpdateRoute } from "./routes/v1/agent.memory.update";
import { agentMemoryDeleteRoute } from "./routes/v1/agent.memory.delete";
import { agentMemoryRememberRoute } from "./routes/v1/agent.memory.remember";
import { agentMemoryPolicyReadRoute } from "./routes/v1/agent.memory_policy.read";
import { agentMemoryPolicyWriteRoute } from "./routes/v1/agent.memory_policy.write";
import { agentMemoryImportParseRoute } from "./routes/v1/agent.memory_import.parse";
import { agentMemoryImportCommitRoute } from "./routes/v1/agent.memory_import.commit";
import { agentMemoryPromoteRoute } from "./routes/v1/agent.memory.promote";
import { agentMemoryPromotionCandidatesRoute } from "./routes/v1/agent.memory_promotion.list";
import { agentMemoryCiteRoute } from "./routes/v1/agent.memory.cite";
import { agentMemoryEvidenceAttachRoute } from "./routes/v1/agent.memory_evidence.attach";
import { agentMemoryCitationsListRoute } from "./routes/v1/agent.memory_citation.list";
import { agentApprovalResolveRoute } from "./routes/v1/agent.approval.resolve";
import { agentExecutionRecordRoute } from "./routes/v1/agent.execution.record";
import { agentSubagentAggregateRoute } from "./routes/v1/agent.subagent.aggregate";
import { agentSubagentResultGetRoute } from "./routes/v1/agent.subagent_result.get";
import { agentSubagentSiblingsRoute } from "./routes/v1/agent.subagent.siblings";
import { agentSubagentFanoutListRoute } from "./routes/v1/agent.subagent_fanout.list";
import { agentSubagentFanoutGetRoute } from "./routes/v1/agent.subagent_fanout.get";
import { agentTraceGetRoute } from "./routes/v1/agent.trace.get";
import { agentDebugTraceRoute } from "./routes/v1/agent.debug.trace";
import { agentExecutionLineageRoute } from "./routes/v1/agent.execution.lineage";
import { agentExecutionListRoute } from "./routes/v1/agent.execution.list";
import { formFillRoute } from "./routes/v1/form.fill";
import { commandMenuSearchRoute } from "./routes/v1/command.menu.search";
import { commandMenuSuggestRoute } from "./routes/v1/command.menu.suggest";
import { archiveCreateRoute } from "./routes/v1/archive.create";
import { documentsGenerateRoute } from "./routes/v1/document.generate";
import { documentsPdfCreateRoute } from "./routes/v1/document.pdf.create";
import { markdownGenerateRoute } from "./routes/v1/markdown.generate";
import { mermaidGenerateRoute } from "./routes/v1/mermaid.generate";
import { videoGenerateRoute } from "./routes/v1/video.generate";
import { svgGenerateRoute } from "./routes/v1/svg.generate";
import { imageGenerateRoute } from "./routes/v1/image.generate";
import { systemInstallInstructionsRoute } from "./routes/v1/system.install.instructions";
import { orgMemberAddRoute } from "./routes/v1/org.member.add";
import { orgMemberInviteAcceptRoute } from "./routes/v1/org.member_invite.accept";
import { orgMemberInviteDeclineRoute } from "./routes/v1/org.member_invite.decline";
import { orgMemberRemoveRoute } from "./routes/v1/org.member.remove";
import { orgMemberRoleChangeRoute } from "./routes/v1/org.member_role.change";
import { userPreferencesReadRoute } from "./routes/v1/user.preferences.read";
import { userPreferencesWriteRoute } from "./routes/v1/user.preferences.write";
import { budgetPolicyReadRoute } from "./routes/v1/budget.policy.read";
import { budgetPolicyWriteRoute } from "./routes/v1/budget.policy.write";
import { workspaceBudgetPolicyReadRoute } from "./routes/v1/workspace.budget_policy.read";
import { workspaceBudgetPolicyWriteRoute } from "./routes/v1/workspace.budget_policy.write";
import { authWhoamiRoute } from "./routes/v1/auth.whoami";
import { workspaceModelSettingsReadRoute } from "./routes/v1/workspace.model_settings.read";
import { workspaceModelSettingsWriteRoute } from "./routes/v1/workspace.model_settings.write";
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
import { conversationAttachmentAddRoute } from "./routes/v1/conversation.attachment.add";
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
import { notificationsListRoute } from "./routes/v1/notification.list";
import { notificationsMarkRoute } from "./routes/v1/notification.mark";
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
import { agentFileLockAcquireRoute } from "./routes/v1/agent.file_lock.acquire";
import { agentFileLockReleaseRoute } from "./routes/v1/agent.file_lock.release";
import { agentFileLockListRoute } from "./routes/v1/agent.file_lock.list";
import { agentSubagentCancelRoute } from "./routes/v1/agent.subagent.cancel";
import { agentSubagentDispatchRoute } from "./routes/v1/agent.subagent.dispatch";
import { agentDefinitionCreateRoute } from "./routes/v1/agent.definition.create";
import { agentDefinitionUpdateRoute } from "./routes/v1/agent.definition.update";
import { agentDefinitionPublishRoute } from "./routes/v1/agent.definition.publish";
import { agentDefinitionGetRoute } from "./routes/v1/agent.definition.get";
import { agentDefinitionListRoute } from "./routes/v1/agent.definition.list";
import { evalDatasetCreateRoute } from "./routes/v1/eval.dataset.create";
import { evalDatasetListRoute } from "./routes/v1/eval.dataset.list";
import { evalDatasetGetRoute } from "./routes/v1/eval.dataset.get";
import { evalDatasetItemAddRoute } from "./routes/v1/eval.dataset_item.add";
import { evalDatasetFromTracesRoute } from "./routes/v1/eval.dataset.from_traces";
import { evalRunStartRoute } from "./routes/v1/eval.run.start";
import { evalRunStatusRoute } from "./routes/v1/eval.run.status";
import { evalRunGetRoute } from "./routes/v1/eval.run.get";
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
import { agentLlmRoute } from "./routes/v1/agent.llm";
import { authCliTokenRoute } from "./routes/v1/auth.cli.token";
import { telemetryUsageRoute } from "./routes/v1/telemetry.usage";
import { a2aWellKnownRoute } from "./routes/a2a/well-known";
import { a2aRpcRoute } from "./routes/a2a/rpc";
import { a2aCardGetRoute } from "./routes/v1/a2a.card.get";

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

// A2A (Agent2Agent) protocol discovery document — public, optional auth. A
// valid workspace API key yields the full workspace card; anonymous callers get
// a base card. Mounted BEFORE the auth-gated groups so discovery never 401s.
app.route("/.well-known", a2aWellKnownRoute);

// Public CLI token exchange — no auth middleware (the code + PKCE verifier are
// the security boundary; RFC 8252 + RFC 7636 S256). Must be mounted BEFORE the
// auth-gated /v1 groups so authMiddleware never sees this path.
app.route("/v1/auth/cli", authCliTokenRoute);

// Public, anonymous CLI usage telemetry (OSS trust surface — TELEMETRY.md).
// No auth is possible (OSS/BYOK users may have no session) or wanted (the
// payload is anonymous by design) — strict schema validation + a per-IP rate
// limit inside the route are the security boundary. Mounted BEFORE the
// auth-gated /v1 groups for the same reason as /v1/auth/cli above.
app.route("/v1/telemetry", telemetryUsageRoute);

// /v1 user-level routes (org + workspace CRUD) require auth but no
// org scope: a freshly-authenticated user can create their first
// org without one existing.
const userScoped = new Hono<AppEnv>();
userScoped.use("*", authMiddleware);
userScoped.route("/organizations", organizationCreateRoute);
// Credential probe + identity echo (auth-only, no scope). Works for both
// session and API-key auth — unlike the user.preferences/org.list pickers
// below, it never requires a userId, so a machine (API-key) client can use it
// to validate its key. This is the canonical `oxagen login` validation probe.
userScoped.route("/auth/whoami", authWhoamiRoute);
// Pre-org tenant + workspace pickers for the CLI linker (auth-only, no scope).
userScoped.route("/user/organizations", orgListRoute);
userScoped.route("/user/workspaces", workspaceListRoute);
userScoped.route("/user/preferences/read", userPreferencesReadRoute);
userScoped.route("/user/preferences/write", userPreferencesWriteRoute);
// Per-turn dollar budget (user-scoped default).
userScoped.route("/user/budget/read", budgetPolicyReadRoute);
userScoped.route("/user/budget/write", budgetPolicyWriteRoute);
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
orgScoped.route("/billing/usage/breakdown", billingUsageBreakdownRoute);
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
// POST /conversations/attachments — link an already-uploaded asset to a conversation.
orgScoped.route("/conversations/attachments", conversationAttachmentAddRoute);
// Agent-runtime routes live under the org + workspace scope so the runner
// inherits the same auth, isolation, and audit envelope as every other v1 call.
orgScoped.route("/agent/code/execute", agentCodeExecuteRoute);
// Durable sandbox sessions (clone → build → snapshot → PR), org+workspace scoped.
orgScoped.route("/agent/sandbox/start", agentSandboxStartRoute);
orgScoped.route("/agent/sandbox/exec", agentSandboxExecRoute);
orgScoped.route("/agent/sandbox/snapshot", agentSandboxSnapshotRoute);
orgScoped.route("/agent/sandbox/stop", agentSandboxStopRoute);
orgScoped.route("/agent/sandbox/files", agentSandboxFilesListRoute);
// Browser automation inside a durable sandbox (proof-of-done), org+workspace scoped.
orgScoped.route("/browser/navigate", browserNavigateRoute);
orgScoped.route("/browser/screenshot", browserScreenshotRoute);
orgScoped.route("/browser/fill", browserFillRoute);
orgScoped.route("/browser/submit", browserSubmitRoute);
orgScoped.route("/browser/click", browserClickRoute);
orgScoped.route("/browser/refresh", browserRefreshRoute);
orgScoped.route("/browser/read", browserReadRoute);
// Cross-LLM proof-of-done judge.
orgScoped.route("/agent/feature/verify", agentFeatureVerifyRoute);
// Code-execution surface peers (OXA-1352) under the same org+workspace scope.
orgScoped.route("/code/diff", codeDiffRoute);
orgScoped.route("/code/patch", codePatchRoute);
orgScoped.route("/code/format", codeFormatRoute);
orgScoped.route("/code/map", codeMapRoute);
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
orgScoped.route("/agent/memory/update", agentMemoryUpdateRoute);
orgScoped.route("/agent/memory/delete", agentMemoryDeleteRoute);
orgScoped.route("/agent/memory/remember", agentMemoryRememberRoute);
orgScoped.route("/agent/memory/policy", agentMemoryPolicyReadRoute);
orgScoped.route("/agent/memory/policy", agentMemoryPolicyWriteRoute);
// Bulk import: parse uploaded docs → drafts, commit the confirmed set. Mounted
// before the "/agent/memory" catch-all so the more specific paths win.
orgScoped.route("/agent/memory/import/parse", agentMemoryImportParseRoute);
orgScoped.route("/agent/memory/import/commit", agentMemoryImportCommitRoute);
orgScoped.route("/agent/memory/promote", agentMemoryPromoteRoute);
orgScoped.route(
  "/agent/memory/promotion/candidates",
  agentMemoryPromotionCandidatesRoute,
);
orgScoped.route("/agent/memory/cite", agentMemoryCiteRoute);
orgScoped.route("/agent/memory/evidence/attach", agentMemoryEvidenceAttachRoute);
orgScoped.route("/agent/memory/citations/list", agentMemoryCitationsListRoute);
orgScoped.route("/agent/memory", agentMemoryWriteRoute);
orgScoped.route("/agent/approvals/resolve", agentApprovalResolveRoute);
orgScoped.route("/agent/execution/record", agentExecutionRecordRoute);
orgScoped.route("/agent/subagent/aggregate", agentSubagentAggregateRoute);
orgScoped.route("/agent/subagent/result", agentSubagentResultGetRoute);
orgScoped.route("/agent/subagent/siblings", agentSubagentSiblingsRoute);
orgScoped.route("/agent/subagent/cancel", agentSubagentCancelRoute);
orgScoped.route("/agent/subagent/dispatch", agentSubagentDispatchRoute);
// Agent file locking (docs/specs/agent-file-locking/plan.md §7): manual
// acquire/force-release/introspection over the HOLDS_LOCK edge write_file/
// edit_file acquire automatically inside every coding-agent turn.
orgScoped.route("/agent/file/lock/acquire", agentFileLockAcquireRoute);
orgScoped.route("/agent/file/lock/release", agentFileLockReleaseRoute);
orgScoped.route("/agent/file/lock/list", agentFileLockListRoute);
// Read side of the fan-out feature: list fan-outs, then get one with child runs.
orgScoped.route("/agent/subagent/fanouts", agentSubagentFanoutListRoute);
orgScoped.route("/agent/subagent/fanout", agentSubagentFanoutGetRoute);
// Agent run-trace span tree: one execution + its steps, tool calls, and child
// executions (subagent/A2A lineage). The list route backs the Activity index.
orgScoped.route("/agent/executions", agentExecutionListRoute);
orgScoped.route("/agent/trace", agentTraceGetRoute);
orgScoped.route("/agent/debug/trace", agentDebugTraceRoute);
// File-level lineage of one execution — the :Execution node plus every
// :SourceFile it touched via TOUCHED_FILE edges, resolved to citable
// KnowledgeNodeRefs (CLAUDE.md "Citing nodes & edges").
orgScoped.route("/agent/executions/lineage", agentExecutionLineageRoute);
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
// Eval datasets/runs: from-traces/get/items sub-paths mounted before the base
// path so they aren't swallowed by the create/list routes' GET/POST on "/".
orgScoped.route("/eval/datasets/from-traces", evalDatasetFromTracesRoute);
orgScoped.route("/eval/datasets/get", evalDatasetGetRoute);
orgScoped.route("/eval/datasets/items", evalDatasetItemAddRoute);
orgScoped.route("/eval/datasets", evalDatasetCreateRoute);
orgScoped.route("/eval/datasets", evalDatasetListRoute);
orgScoped.route("/eval/runs/status", evalRunStatusRoute);
orgScoped.route("/eval/runs/get", evalRunGetRoute);
orgScoped.route("/eval/runs", evalRunStartRoute);
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
orgScoped.route("/workspace/budget-policy", workspaceBudgetPolicyReadRoute);
orgScoped.route("/workspace/budget-policy", workspaceBudgetPolicyWriteRoute);
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
// A2A Agent Card management read (metered, IAM-gated) — the governed parity
// surface for the card; the transport itself lives at /a2a + /.well-known.
orgScoped.route("/a2a/card", a2aCardGetRoute);
app.route("/v1/:org_slug/:workspace_slug", orgScoped);

// OpenAI-compatible agent LLM proxy (ADR-019 B4): the CLI routes ALL model
// inference through the platform via `@ai-sdk/openai-compatible` (no BYOK).
// Auth is the platform API key (Bearer); the key carries org+workspace scope,
// so this surface sits OUTSIDE the /:org/:workspace path group. The static
// `/v1/agent/llm` prefix takes priority over the `:org_slug/:workspace_slug`
// param route in Hono's router. Full path: POST /v1/agent/llm/chat/completions.
const agentLlmScoped = new Hono<AppEnv>();
agentLlmScoped.use("*", authMiddleware);
agentLlmScoped.route("/", agentLlmRoute);
app.route("/v1/agent/llm", agentLlmScoped);

// A2A (Agent2Agent) protocol JSON-RPC transport. Like /mcp, it is a transport,
// not a per-capability surface: the workspace API key (Bearer) carries org+
// workspace scope, so it sits OUTSIDE the /:org/:workspace path group and is
// gated by authMiddleware only. Full endpoint: POST /a2a.
const a2aScoped = new Hono<AppEnv>();
a2aScoped.use("*", authMiddleware);
a2aScoped.route("/", a2aRpcRoute);
app.route("/a2a", a2aScoped);

// Public OAuth callback — HMAC-verified state param is the security boundary.
// Must NOT be inside the workspace-scoped group (user has no session when GitHub redirects).
app.route("/oauth/github", githubOauthCallbackRoute);

import { Hono } from "hono";
import type { CapabilityContext } from "@oxagen/oxagen";
import { requestLogger } from "./middleware/logger";
import { corsMiddleware } from "./middleware/cors";
import { errorMiddleware } from "./middleware/error";
import { authMiddleware } from "./middleware/auth";
import { orgMiddleware } from "./middleware/org";
import { workspaceMiddleware } from "./middleware/workspace";
import {
  distributedRateLimiter,
  rateLimitBudgets,
} from "./middleware/distributed-rate-limit";
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
import { resellerRoute } from "./routes/v1/reseller";
import { chatMessageSendRoute } from "./routes/v1/chat.message.send";
import { chatMessageExecutionRoute } from "./routes/v1/chat.message.execution";
import { chatStreamRoute } from "./routes/v1/chat.stream";
import { agentRunRoute } from "./routes/v1/agent.run";
import { agentCodeExecuteRoute } from "./routes/v1/agent.code.execute";
import { agentSandboxStartRoute } from "./routes/v1/agent.sandbox.start";
import { agentSandboxExecRoute } from "./routes/v1/agent.sandbox.exec";
import { agentSandboxSnapshotRoute } from "./routes/v1/agent.sandbox.snapshot";
import { agentSandboxStopRoute } from "./routes/v1/agent.sandbox.stop";
import { agentSandboxRenameRoute } from "./routes/v1/agent.sandbox.rename";
import { agentSandboxListRoute } from "./routes/v1/agent.sandbox.list";
import { agentSandboxFilesListRoute } from "./routes/v1/agent.sandbox_file.list";
import { agentSandboxLogsListRoute } from "./routes/v1/agent.sandbox_log.list";
import { agentSandboxFileReadRoute } from "./routes/v1/agent.sandbox_file.read";
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
import { agentMcpResolveRoute } from "./routes/v1/agent.mcp.resolve";
import { agentMcpSetEnabledRoute } from "./routes/v1/agent.mcp.set_enabled";
import { agentMcpDeleteRoute } from "./routes/v1/agent.mcp.delete";
import { agentMcpConsentResolveRoute } from "./routes/v1/agent.mcp_consent.resolve";
import { agentMcpConsentListRoute } from "./routes/v1/agent.mcp_consent.list";
import { agentSkillListRoute } from "./routes/v1/agent.skill.list";
import { agentSkillLoadRoute } from "./routes/v1/agent.skill.load";
import { agentPlanApproveRoute } from "./routes/v1/agent.plan.approve";
import { agentPlanCreateRoute } from "./routes/v1/agent.plan.create";
import { agentPlanGetRoute } from "./routes/v1/agent.plan.get";
import { agentPlanListRoute } from "./routes/v1/agent.plan.list";
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
import { telemetryErrorClusterRoute } from "./routes/v1/telemetry.error.cluster";
import { agentExecutionLineageRoute } from "./routes/v1/agent.execution.lineage";
import { agentExecutionListRoute } from "./routes/v1/agent.execution.list";
import { formFillRoute } from "./routes/v1/form.fill";
import { commandMenuSearchRoute } from "./routes/v1/command.menu.search";
import { commandMenuSuggestRoute } from "./routes/v1/command.menu.suggest";
import { referenceSearchRoute } from "./routes/v1/reference.search";
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
import { userWorkspacePreferencesReadRoute } from "./routes/v1/user.workspace_preferences.read";
import { userWorkspacePreferencesWriteRoute } from "./routes/v1/user.workspace_preferences.write";
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
import { conversationExportRoute } from "./routes/v1/conversation.export";
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
import { pluginSetEnabledRoute } from "./routes/v1/plugin.set_enabled";
import { pluginCredentialSetSecretRoute } from "./routes/v1/plugin.credential.set_secret";
import { pluginCredentialReauthRoute } from "./routes/v1/plugin.credential.reauth";
import { pluginCredentialRevokeRoute } from "./routes/v1/plugin.credential.revoke";
// Environments + credential vault (Spec: 2026-06-24-credential-vault-…).
import { environmentCreateRoute } from "./routes/v1/environment.create";
import { environmentListRoute } from "./routes/v1/environment.list";
import { environmentGetRoute } from "./routes/v1/environment.get";
import { environmentUpdateRoute } from "./routes/v1/environment.update";
import { environmentDeleteRoute } from "./routes/v1/environment.delete";
import { environmentSetDefaultRoute } from "./routes/v1/environment.set_default";
// Sandbox templates + portable artifacts + agent-environment bindings (Spec §5.2–§5.6).
import { sandboxTemplateCreateRoute } from "./routes/v1/sandbox.template.create";
import { sandboxTemplateListRoute } from "./routes/v1/sandbox.template.list";
import { sandboxTemplateGetRoute } from "./routes/v1/sandbox.template.get";
import { sandboxTemplateUpdateRoute } from "./routes/v1/sandbox.template.update";
import { sandboxTemplateDeleteRoute } from "./routes/v1/sandbox.template.delete";
import { sandboxTemplateSetDefaultRoute } from "./routes/v1/sandbox.template.set_default";
import { sandboxTemplateSetToolsRoute } from "./routes/v1/sandbox.template.set_tools";
import { sandboxTemplateExportRoute } from "./routes/v1/sandbox.template.export";
import { sandboxTemplateImportRoute } from "./routes/v1/sandbox.template.import";
import { agentEnvironmentBindRoute } from "./routes/v1/agent.environment.bind";
import { agentEnvironmentUnbindRoute } from "./routes/v1/agent.environment.unbind";
import { agentEnvironmentListRoute } from "./routes/v1/agent.environment.list";
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
import { pluginSettingsGetAuthAlertsRoute } from "./routes/v1/plugin.settings.get_auth_alerts";
import { capabilityRegistryListRoute } from "./routes/v1/capability.registry.list";
import { capabilityRegistryGetRoute } from "./routes/v1/capability.registry.get";
import { iamRoleListRoute } from "./routes/v1/iam.role.list";
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
import { automationGetRoute } from "./routes/v1/automation.get";
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
import { skillDraftRoute } from "./routes/v1/skill.draft";
import { skillReviseRoute } from "./routes/v1/skill.revise";
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
import { agentDefinitionSuggestRoute } from "./routes/v1/agent.definition.suggest";
import { agentDefinitionReviseRoute } from "./routes/v1/agent.definition.revise";
import { agentDefinitionSummarizeRoute } from "./routes/v1/agent.definition.summarize";
import { evalDatasetCreateRoute } from "./routes/v1/eval.dataset.create";
import { evalDatasetListRoute } from "./routes/v1/eval.dataset.list";
import { evalDatasetGetRoute } from "./routes/v1/eval.dataset.get";
import { evalDatasetItemAddRoute } from "./routes/v1/eval.dataset_item.add";
import { evalDatasetFromTracesRoute } from "./routes/v1/eval.dataset.from_traces";
import { evalRunStartRoute } from "./routes/v1/eval.run.start";
import { evalRunStatusRoute } from "./routes/v1/eval.run.status";
import { evalRunGetRoute } from "./routes/v1/eval.run.get";
import { evalRunListRoute } from "./routes/v1/eval.run.list";
import { evalRunSeriesRoute } from "./routes/v1/eval.run.series";
import { routerPolicyGetRoute } from "./routes/v1/router.policy.get";
import { routerPolicySetRoute } from "./routes/v1/router.policy.set";
import { routerStatsListRoute } from "./routes/v1/router.stats.list";
import { routerDecisionPreviewRoute } from "./routes/v1/router.decision.preview";
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
import { cmsRoute } from "./routes/v1/cms";
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

// Public, anonymous ebook lead gate for the marketing site (oxagen.sh). Same
// security model as /v1/telemetry: no auth (callers are website visitors),
// strict schema validation + per-IP rate limit inside the route. Mounted BEFORE
// the auth-gated /v1 groups so a lead POST never hits authMiddleware.
app.route("/v1/cms", cmsRoute);

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

// Distributed, workspace-keyed rate limiters for the expensive surfaces. Budgets
// are env-tunable (requests/minute) with conservative defaults; the store is
// Postgres so the limit is global across serverless instances (the in-memory
// rateLimiter would only bound each warm instance). `max` is a lazy resolver so
// the env budget is read on the first limited request, not at module load —
// importing app.ts (route tests, tooling) must never require env access.
const chatRateLimiter = distributedRateLimiter({
  keyPrefix: "chat",
  max: () => rateLimitBudgets().chat,
});
const agentExecRateLimiter = distributedRateLimiter({
  keyPrefix: "agent",
  max: () => rateLimitBudgets().agentExec,
});
// A2A is an external agent-to-agent surface — give it its own bucket (same
// budget) so inbound A2A traffic can't starve the interactive agent bucket.
const a2aRateLimiter = distributedRateLimiter({
  keyPrefix: "a2a",
  max: () => rateLimitBudgets().agentExec,
});

// /v1/:org_slug/:workspace_slug/* — org + workspace scoped routes.
const orgScoped = new Hono<AppEnv>();
orgScoped.use("*", authMiddleware, orgMiddleware, workspaceMiddleware);
// Rate limiting: mounted AFTER auth/org/workspace (so orgId/workspaceId are
// populated for keying) and BEFORE the route registrations below — Hono runs
// middleware in registration order, so a limiter registered after a route would
// not wrap it. The limiter counts POST only, so cheap co-located GET reads
// (e.g. /agent/sandbox/list under the /agent/sandbox/* mount, or the
// /agent/tasks background-task read) pass through untouched.
orgScoped.use("/chat/*", chatRateLimiter);
orgScoped.use("/agent/code/execute", agentExecRateLimiter);
orgScoped.use("/agent/compose", agentExecRateLimiter);
orgScoped.use("/agent/sandbox/*", agentExecRateLimiter);
orgScoped.use("/agent/tasks", agentExecRateLimiter);
orgScoped.route("/workspaces", workspaceCreateRoute);
orgScoped.route("/billing/subscription", billingSubscriptionReadRoute);
orgScoped.route(
  "/billing/subscription/upgrade/start",
  billingSubscriptionUpgradeStartRoute,
);
orgScoped.route("/billing/credits/purchase", billingCreditsPurchaseRoute);
orgScoped.route("/billing/usage/breakdown", billingUsageBreakdownRoute);
orgScoped.route("/billing/revenue", resellerRoute);
orgScoped.route("/chat/messages", chatMessageSendRoute);
orgScoped.route("/chat/messages/execution", chatMessageExecutionRoute);
orgScoped.route("/chat/stream", chatStreamRoute);
orgScoped.route("/conversations", conversationListRoute);
// GET /conversations/:conversationId/files — registered at the same prefix as the
// list route; Hono dispatches by method+full path so it does not clash with the
// bare GET /conversations list or the /conversations/{rename,archive,…} sub-paths.
orgScoped.route("/conversations", conversationFilesListRoute);
// GET /conversations/:conversationId/export — same prefix trick as /files above.
orgScoped.route("/conversations", conversationExportRoute);
orgScoped.route("/conversations/rename", conversationRenameRoute);
orgScoped.route("/conversations/archive", conversationArchiveRoute);
orgScoped.route("/conversations/delete", conversationDeleteRoute);
orgScoped.route("/conversations/purge", conversationPurgeRoute);
// POST /conversations/attachments — link an already-uploaded asset to a conversation.
orgScoped.route("/conversations/attachments", conversationAttachmentAddRoute);
// Agent-runtime routes live under the org + workspace scope so the runner
// inherits the same auth, isolation, and audit envelope as every other v1 call.
orgScoped.route("/agent/code/execute", agentCodeExecuteRoute);
// Durable-run API (agent-engine v2 Phase 2 integration) — flag-gated behind
// OXAGEN_DURABLE_RUNS; every route under /runs 404s until that var is "1"/
// "true" (packages/config/src/registry.ts). Enqueue/status/resumable-SSE/
// cancel over @oxagen/agent-runner's RunStore, not the capability kernel.
orgScoped.route("/runs", agentRunRoute);
// Durable sandbox sessions (clone → build → snapshot → PR), org+workspace scoped.
orgScoped.route("/agent/sandbox/start", agentSandboxStartRoute);
orgScoped.route("/agent/sandbox/exec", agentSandboxExecRoute);
orgScoped.route("/agent/sandbox/snapshot", agentSandboxSnapshotRoute);
orgScoped.route("/agent/sandbox/stop", agentSandboxStopRoute);
// Set a session's human-friendly display label (metadata-only, no driver call).
orgScoped.route("/agent/sandbox/rename", agentSandboxRenameRoute);
// List durable sessions in the workspace (id, status, timestamps) — read-only.
orgScoped.route("/agent/sandbox/list", agentSandboxListRoute);
orgScoped.route("/agent/sandbox/files", agentSandboxFilesListRoute);
// Captured stdout/stderr/command output for a session — the log-console read.
orgScoped.route("/agent/sandbox/logs", agentSandboxLogsListRoute);
// Single-file read — the viewer counterpart of the /files listing above.
orgScoped.route("/agent/sandbox/file", agentSandboxFileReadRoute);
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
orgScoped.route("/agent/mcp-servers/resolve", agentMcpResolveRoute);
orgScoped.route("/agent/mcp-servers/set-enabled", agentMcpSetEnabledRoute);
orgScoped.route("/agent/mcp-servers/delete", agentMcpDeleteRoute);
orgScoped.route("/agent/mcp-consents/resolve", agentMcpConsentResolveRoute);
orgScoped.route("/agent/mcp-consents", agentMcpConsentListRoute);
orgScoped.route("/agent/skills", agentSkillListRoute);
orgScoped.route("/agent/skills/load", agentSkillLoadRoute);
orgScoped.route("/agent/plans/approve", agentPlanApproveRoute);
orgScoped.route("/agent/plans/get", agentPlanGetRoute);
orgScoped.route("/agent/plans/list", agentPlanListRoute);
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
orgScoped.route(
  "/agent/memory/evidence/attach",
  agentMemoryEvidenceAttachRoute,
);
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
// Fleet-wide error triage overview — clusters ClickHouse error_events by
// fingerprint. Pure SQL (ADR-021 §1), the counterpart to agent/debug/trace's
// single-execution failure frame above.
orgScoped.route("/telemetry/error/cluster", telemetryErrorClusterRoute);
// File-level lineage of one execution — the :Execution node plus every
// :SourceFile it touched via TOUCHED_FILE edges, resolved to citable
// KnowledgeNodeRefs (CLAUDE.md "Citing nodes & edges").
orgScoped.route("/agent/executions/lineage", agentExecutionLineageRoute);
// Agent lifecycle: definitions, deployment, triggers. The /update and /publish
// sub-paths are mounted before the get route so they are not swallowed by its
// GET /:agentId param match.
orgScoped.route("/agent/definitions/update", agentDefinitionUpdateRoute);
orgScoped.route("/agent/definitions/publish", agentDefinitionPublishRoute);
orgScoped.route("/agent/definitions/suggest", agentDefinitionSuggestRoute);
orgScoped.route("/agent/definitions/revise", agentDefinitionReviseRoute);
orgScoped.route("/agent/definitions/summarize", agentDefinitionSummarizeRoute);
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
orgScoped.route("/eval/runs/list", evalRunListRoute);
orgScoped.route("/eval/runs/series", evalRunSeriesRoute);
orgScoped.route("/eval/runs", evalRunStartRoute);
// Verified-Outcome Market Router governance + inspection.
orgScoped.route("/router/policy/set", routerPolicySetRoute);
orgScoped.route("/router/policy", routerPolicyGetRoute);
orgScoped.route("/router/stats", routerStatsListRoute);
orgScoped.route("/router/preview", routerDecisionPreviewRoute);
orgScoped.route("/forms/fill", formFillRoute);
orgScoped.route("/command/menu/search", commandMenuSearchRoute);
orgScoped.route("/command/menu/suggest", commandMenuSuggestRoute);
orgScoped.route("/reference/search", referenceSearchRoute);
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
// Per-(user, workspace) coding-agent defaults (org+workspace scoped).
orgScoped.route(
  "/user/workspace-preferences",
  userWorkspacePreferencesReadRoute,
);
orgScoped.route(
  "/user/workspace-preferences",
  userWorkspacePreferencesWriteRoute,
);
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
orgScoped.route("/plugin/set-enabled", pluginSetEnabledRoute);
orgScoped.route(
  "/plugin/credential/set-secret",
  pluginCredentialSetSecretRoute,
);
orgScoped.route("/plugin/credential/reauth", pluginCredentialReauthRoute);
orgScoped.route("/plugin/credential/revoke", pluginCredentialRevokeRoute);
// Environments + credential vault.
orgScoped.route("/environment/create", environmentCreateRoute);
orgScoped.route("/environment/list", environmentListRoute);
orgScoped.route("/environment/get", environmentGetRoute);
orgScoped.route("/environment/update", environmentUpdateRoute);
orgScoped.route("/environment/delete", environmentDeleteRoute);
orgScoped.route("/environment/set-default", environmentSetDefaultRoute);
// Sandbox templates + portable artifacts + agent-environment bindings.
orgScoped.route("/sandbox/template/create", sandboxTemplateCreateRoute);
orgScoped.route("/sandbox/template/list", sandboxTemplateListRoute);
orgScoped.route("/sandbox/template/get", sandboxTemplateGetRoute);
orgScoped.route("/sandbox/template/update", sandboxTemplateUpdateRoute);
orgScoped.route("/sandbox/template/delete", sandboxTemplateDeleteRoute);
orgScoped.route(
  "/sandbox/template/set-default",
  sandboxTemplateSetDefaultRoute,
);
orgScoped.route("/sandbox/template/set-tools", sandboxTemplateSetToolsRoute);
orgScoped.route("/sandbox/template/export", sandboxTemplateExportRoute);
orgScoped.route("/sandbox/template/import", sandboxTemplateImportRoute);
orgScoped.route("/agent/environment/bind", agentEnvironmentBindRoute);
orgScoped.route("/agent/environment/unbind", agentEnvironmentUnbindRoute);
orgScoped.route("/agent/environment/list", agentEnvironmentListRoute);
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
// GET on the same path reads the setting (separate thin adapter per capability).
orgScoped.route(
  "/plugin/settings/auth-alerts",
  pluginSettingsGetAuthAlertsRoute,
);
// Typed-contract registry reads — the governance catalog's data source.
orgScoped.route("/capability/registry/list", capabilityRegistryListRoute);
orgScoped.route("/capability/registry/get", capabilityRegistryGetRoute);
// IAM roles read (read-only; writes remain provisioning-script-only).
orgScoped.route("/iam/roles/list", iamRoleListRoute);
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
orgScoped.route("/automation/get", automationGetRoute);
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
orgScoped.route("/skill/draft", skillDraftRoute);
orgScoped.route("/skill/revise", skillReviseRoute);
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
// Rate-limit the A2A RPC transport (POST /a2a) — the API key carries
// org+workspace scope, so the limiter keys per workspace just like the /v1
// agent surfaces. Registered before the route so it wraps it.
a2aScoped.use("*", a2aRateLimiter);
a2aScoped.route("/", a2aRpcRoute);
app.route("/a2a", a2aScoped);

// Public OAuth callback — HMAC-verified state param is the security boundary.
// Must NOT be inside the workspace-scoped group (user has no session when GitHub redirects).
app.route("/oauth/github", githubOauthCallbackRoute);

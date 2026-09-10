import { Hono } from "hono";
import type { CapabilityContext } from "@oxagen/oxagen";
import { requestLogger } from "./middleware/logger";
import { corsMiddleware } from "./middleware/cors";
import { errorMiddleware } from "./middleware/error";
import { authMiddleware } from "./middleware/auth";
import { orgMiddleware } from "./middleware/org";
import { workspaceMiddleware } from "./middleware/workspace";
import {
  authorizationFingerprintBucketKey,
  distributedRateLimiter,
  rateLimitBudgets,
  trustedVercelIpBucketKey,
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
import { chatMessageSendRoute } from "./routes/v1/chat.message.send";
import { chatMessageExecutionRoute } from "./routes/v1/chat.message.execution";
import { chatStreamRoute } from "./routes/v1/chat.stream";
import { agentToolListRoute } from "./routes/v1/agent.tool.list";
import { agentMcpRegisterRoute } from "./routes/v1/agent.mcp.register";
import { agentMcpListRoute } from "./routes/v1/agent.mcp.list";
import { agentMcpResolveRoute } from "./routes/v1/agent.mcp.resolve";
import { agentMcpSetEnabledRoute } from "./routes/v1/agent.mcp.set_enabled";
import { agentMcpDeleteRoute } from "./routes/v1/agent.mcp.delete";
import { agentMcpConsentResolveRoute } from "./routes/v1/agent.mcp_consent.resolve";
import { agentMcpConsentListRoute } from "./routes/v1/agent.mcp_consent.list";
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
import { agentMemoryDemoteRoute } from "./routes/v1/agent.memory.demote";
import { agentMemoryPromotionCandidatesRoute } from "./routes/v1/agent.memory_promotion.list";
import { agentMemoryPromotionDismissRoute } from "./routes/v1/agent.memory_promotion.dismiss";
import { agentMemoryPromotionRationalesRoute } from "./routes/v1/agent.memory_promotion.rationales";
import { agentMemoryCiteRoute } from "./routes/v1/agent.memory.cite";
import { agentMemoryEvidenceAttachRoute } from "./routes/v1/agent.memory_evidence.attach";
import { agentMemoryCitationsListRoute } from "./routes/v1/agent.memory_citation.list";
import { agentMemoryCitationStatsRoute } from "./routes/v1/agent.memory_citation.stats";
import { agentApprovalResolveRoute } from "./routes/v1/agent.approval.resolve";
import { agentExecutionRecordRoute } from "./routes/v1/agent.execution.record";
import { agentTraceGetRoute } from "./routes/v1/agent.trace.get";
import { agentDebugTraceRoute } from "./routes/v1/agent.debug.trace";
import { telemetryErrorClusterRoute } from "./routes/v1/telemetry.error.cluster";
import { agentExecutionListRoute } from "./routes/v1/agent.execution.list";
import { modelCapabilityListRoute } from "./routes/v1/model.capability.list";
import { commandMenuSearchRoute } from "./routes/v1/command.menu.search";
import { commandMenuSuggestRoute } from "./routes/v1/command.menu.suggest";
import { referenceSearchRoute } from "./routes/v1/reference.search";
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
import { billingBudgetGetRoute } from "./routes/v1/billing.budget.get";
import { billingBudgetSetRoute } from "./routes/v1/billing.budget.set";
import { userWorkspacePreferencesReadRoute } from "./routes/v1/user.workspace_preferences.read";
import { userWorkspacePreferencesWriteRoute } from "./routes/v1/user.workspace_preferences.write";
import { authWhoamiRoute } from "./routes/v1/auth.whoami";
import { workspaceModelSettingsReadRoute } from "./routes/v1/workspace.model_settings.read";
import { workspaceModelSettingsWriteRoute } from "./routes/v1/workspace.model_settings.write";
import { promptSettingsReadRoute } from "./routes/v1/prompt.settings.read";
import { promptSettingsWriteRoute } from "./routes/v1/prompt.settings.write";
import { orgDataPlaneRoute } from "./routes/v1/org.data_plane";
import { orgModelCredentialRoute } from "./routes/v1/org.model_credential";
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
// Environments + credential vault.
import { environmentCreateRoute } from "./routes/v1/environment.create";
import { environmentListRoute } from "./routes/v1/environment.list";
import { environmentGetRoute } from "./routes/v1/environment.get";
import { environmentUpdateRoute } from "./routes/v1/environment.update";
import { environmentDeleteRoute } from "./routes/v1/environment.delete";
import { environmentSetDefaultRoute } from "./routes/v1/environment.set_default";
// Agent ↔ environment bindings.
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
import { workspaceMemberListRoute } from "./routes/v1/workspace.member.list";
import { workspaceInviteSendRoute } from "./routes/v1/workspace.invite.send";
import { conversationChatRoute } from "./routes/v1/conversation.chat";
import { toolDeclarationPublishRoute } from "./routes/v1/tool.declaration.publish";
import { toolDeclarationListRoute } from "./routes/v1/tool.declaration.list";
import { contextRecordPublishRoute } from "./routes/v1/context.record.publish";
import { contextRecordListRoute } from "./routes/v1/context.record.list";
import { contextRecordPromoteRoute } from "./routes/v1/context.record.promote";
import { agentDefinitionCreateRoute } from "./routes/v1/agent.definition.create";
import { agentDefinitionDeleteRoute } from "./routes/v1/agent.definition.delete";
import { agentDefinitionUpdateRoute } from "./routes/v1/agent.definition.update";
import { agentDefinitionPublishRoute } from "./routes/v1/agent.definition.publish";
import { agentDefinitionGetRoute } from "./routes/v1/agent.definition.get";
import { agentDefinitionListRoute } from "./routes/v1/agent.definition.list";
import { agentRoleAssignRoute } from "./routes/v1/agent.role.assign";
import { agentRoleRevokeRoute } from "./routes/v1/agent.role.revoke";
import { agentRoleListRoute } from "./routes/v1/agent.role.list";
import { agentRoleGetRoute } from "./routes/v1/agent.role.get";
import { agentDefinitionSuggestRoute } from "./routes/v1/agent.definition.suggest";
import { agentDefinitionReviseRoute } from "./routes/v1/agent.definition.revise";
import { agentDefinitionSummarizeRoute } from "./routes/v1/agent.definition.summarize";
import { routerPolicyGetRoute } from "./routes/v1/router.policy.get";
import { routerPolicySetRoute } from "./routes/v1/router.policy.set";
import { routerStatsListRoute } from "./routes/v1/router.stats.list";
import { routerDecisionPreviewRoute } from "./routes/v1/router.decision.preview";
import { agentDeployRoute } from "./routes/v1/agent.deploy";
import { privacyDataExportRoute } from "./routes/v1/privacy.data.export";
import { privacyDataEraseRoute } from "./routes/v1/privacy.data.erase";
import { connectionRoute } from "./routes/v1/connection";
import { webhookRoute } from "./routes/v1/webhook";
import {
  githubOauthRoute,
  githubOauthCallbackRoute,
} from "./routes/v1/github-oauth";
import { githubAppWebhookRoute } from "./routes/v1/github-webhook";
import { graphNodeGetRoute } from "./routes/v1/graph.node.get";
import { graphNodeSearchRoute } from "./routes/v1/graph.node.search";
import { graphSearchRoute } from "./routes/v1/graph.search";
import { repoRoute } from "./routes/v1/repo";
import { integrationRoute } from "./routes/v1/integration";
import { schemaRoute } from "./routes/v1/schema";
import {
  pluginSchemaRoute,
  pluginVersionRoute,
} from "./routes/v1/plugin-schema";
import { graphNodeListRoute } from "./routes/v1/graph.node.list";
import { graphStatsRoute } from "./routes/v1/graph.stats";
import { ontologyQueryRoute } from "./routes/v1/ontology.query";
import { ontologyNeighborsRoute } from "./routes/v1/ontology.neighbors";
import { auditLogQueryRoute } from "./routes/v1/audit.log.query";
import { authCliTokenRoute } from "./routes/v1/auth.cli.token";
import { telemetryUsageRoute } from "./routes/v1/telemetry.usage";
import { telemetryStellaEnrollRoute } from "./routes/v1/telemetry.stella.enroll";
import { telemetryStellaIngestRoute } from "./routes/v1/telemetry.stella.ingest";
import { tachoBundleGetRoute } from "./routes/v1/tacho.bundle.get";
import { tachoCommandDispatchRoute } from "./routes/v1/tacho.command.dispatch";
import { tachoCommandFetchRoute } from "./routes/v1/tacho.command.fetch";
import { tachoEnrollmentCreateRoute } from "./routes/v1/tacho.enrollment.create";
import { tachoEnrollmentRevokeRoute } from "./routes/v1/tacho.enrollment.revoke";
import { tachoEventsIngestRoute } from "./routes/v1/tacho.events.ingest";
import { tachoHostListRoute } from "./routes/v1/tacho.host.list";
import { tachoSessionGetRoute } from "./routes/v1/tacho.session.get";
import { tachoSessionListRoute } from "./routes/v1/tacho.session.list";

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

// Shared pre-authentication ceilings for credential stuffing on Stella intake.
// Register both on the concrete root path before the auth-gated subrouter:
// Hono preserves parent registration order, so exhausted buckets never reach
// API-key resolution. The generous trusted-IP ceiling keeps shared enterprise
// NATs usable; the credential fingerprint limits one abused key across IPs.
app.use(
  "/v1/telemetry/stella/*",
  distributedRateLimiter({
    keyPrefix: "stella-preauth-ip",
    max: 3_000,
    bucketKey: trustedVercelIpBucketKey,
    methods: "all",
    failClosedOnStoreError: true,
  }),
);
app.use(
  "/v1/telemetry/stella/*",
  distributedRateLimiter({
    keyPrefix: "stella-preauth-credential",
    max: 60,
    bucketKey: authorizationFingerprintBucketKey,
    methods: "all",
    failClosedOnStoreError: true,
  }),
);

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

// Post-auth ceiling for enrolled Stella evidence ingress, in requests/minute.
// A constant rather than an env budget: ADR-043 retired the agent runtime and
// with it RATE_LIMIT_AGENT_EXEC_PER_MIN, whose value this limiter used to
// borrow. The two pre-auth ceilings on the same path (just below) are constants
// for the same reason — a drain rate is a property of the ingress, not of a
// per-deployment knob. The value matches the retired budget's default so the
// effective limit is unchanged.
const STELLA_TELEMETRY_PER_MIN = 30;

// Enrolled Stella operational telemetry is machine-to-machine only. The
// workspace API key carries its immutable org+workspace scope, so this static
// path sits outside the human-readable /:org_slug/:workspace_slug group.
const stellaTelemetryScoped = new Hono<AppEnv>();
stellaTelemetryScoped.use("*", authMiddleware);
stellaTelemetryScoped.use(
  "*",
  distributedRateLimiter({
    keyPrefix: "stella-telemetry",
    max: STELLA_TELEMETRY_PER_MIN,
  }),
);
stellaTelemetryScoped.route("/", telemetryStellaIngestRoute);
app.route("/v1/telemetry/stella", stellaTelemetryScoped);

// Tacho hosts speak to Oxagen with their enrolled API key, whose scope pins
// org and workspace, so the machine routes sit on a static path outside the
// slug group. Same pre-auth ceilings as the Stella intake: a per-IP bucket
// for shared NATs and a per-credential bucket for one abused key.
app.use(
  "/v1/tacho/*",
  distributedRateLimiter({
    keyPrefix: "tacho-preauth-ip",
    max: 6_000,
    bucketKey: trustedVercelIpBucketKey,
    methods: "all",
    failClosedOnStoreError: true,
  }),
);
app.use(
  "/v1/tacho/*",
  distributedRateLimiter({
    keyPrefix: "tacho-preauth-credential",
    max: 120,
    bucketKey: authorizationFingerprintBucketKey,
    methods: "all",
    failClosedOnStoreError: true,
  }),
);
// Post-auth ceiling for an enrolled Tacho host, in requests/minute. A constant
// for the same reason as STELLA_TELEMETRY_PER_MIN above: ADR-043 retired
// RATE_LIMIT_AGENT_EXEC_PER_MIN, whose value this limiter used to borrow, and a
// drain rate belongs to the ingress rather than to a per-deployment knob. The
// value matches the retired budget's default so the effective limit is unchanged.
const TACHO_HOST_PER_MIN = 30;

const tachoScoped = new Hono<AppEnv>();
tachoScoped.use("*", authMiddleware);
tachoScoped.use(
  "*",
  distributedRateLimiter({
    keyPrefix: "tacho-host",
    max: TACHO_HOST_PER_MIN,
  }),
);
tachoScoped.route("/", tachoEventsIngestRoute);
tachoScoped.route("/", tachoBundleGetRoute);
tachoScoped.route("/", tachoCommandFetchRoute);
app.route("/v1/tacho", tachoScoped);

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
// /v1/:org_slug/:workspace_slug/* — org + workspace scoped routes.
const orgScoped = new Hono<AppEnv>();
orgScoped.use("*", authMiddleware, orgMiddleware, workspaceMiddleware);
// Rate limiting: mounted AFTER auth/org/workspace (so orgId/workspaceId are
// populated for keying) and BEFORE the route registrations below — Hono runs
// middleware in registration order, so a limiter registered after a route would
// not wrap it. The limiter counts POST only, so cheap co-located GET reads pass
// through untouched.
orgScoped.use("/chat/*", chatRateLimiter);
orgScoped.route("/workspaces", workspaceCreateRoute);
// Minting an enrollment is an operator action, so it sits behind the session
// auth this router applies — not beside the ingest route, whose API-key gate
// an already-enrolled machine could otherwise use to mint more enrollments.
orgScoped.route("/telemetry/stella/enrollments", telemetryStellaEnrollRoute);
// Tacho operator actions: enrol and revoke hosts, command them, and read the
// fleet. Session auth with the org role checked in the handlers.
orgScoped.route("/tacho/enrollments", tachoEnrollmentCreateRoute);
orgScoped.route("/tacho/enrollments/revoke", tachoEnrollmentRevokeRoute);
orgScoped.route("/tacho/commands", tachoCommandDispatchRoute);
orgScoped.route("/tacho/hosts", tachoHostListRoute);
orgScoped.route("/tacho/sessions", tachoSessionListRoute);
orgScoped.route("/tacho/sessions/get", tachoSessionGetRoute);
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
// GET /conversations/:conversationId/export — same prefix trick as /files above.
orgScoped.route("/conversations", conversationExportRoute);
orgScoped.route("/conversations/rename", conversationRenameRoute);
orgScoped.route("/conversations/archive", conversationArchiveRoute);
orgScoped.route("/conversations/delete", conversationDeleteRoute);
orgScoped.route("/conversations/purge", conversationPurgeRoute);
// POST /conversations/attachments — link an already-uploaded asset to a conversation.
orgScoped.route("/conversations/attachments", conversationAttachmentAddRoute);
// Agent governance routes live under the org + workspace scope so every call
// inherits the same auth, isolation, and audit envelope as the rest of v1.
orgScoped.route("/agent/tools", agentToolListRoute);
orgScoped.route("/agent/mcp-servers", agentMcpRegisterRoute);
orgScoped.route("/agent/mcp-servers", agentMcpListRoute);
orgScoped.route("/agent/mcp-servers/resolve", agentMcpResolveRoute);
orgScoped.route("/agent/mcp-servers/set-enabled", agentMcpSetEnabledRoute);
orgScoped.route("/agent/mcp-servers/delete", agentMcpDeleteRoute);
orgScoped.route("/agent/mcp-consents/resolve", agentMcpConsentResolveRoute);
orgScoped.route("/agent/mcp-consents", agentMcpConsentListRoute);
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
orgScoped.route("/agent/memory/demote", agentMemoryDemoteRoute);
orgScoped.route(
  "/agent/memory/promotion/candidates",
  agentMemoryPromotionCandidatesRoute,
);
orgScoped.route(
  "/agent/memory/promotion/dismiss",
  agentMemoryPromotionDismissRoute,
);
orgScoped.route(
  "/agent/memory/promotion/rationales",
  agentMemoryPromotionRationalesRoute,
);
orgScoped.route("/agent/memory/cite", agentMemoryCiteRoute);
orgScoped.route(
  "/agent/memory/evidence/attach",
  agentMemoryEvidenceAttachRoute,
);
orgScoped.route("/agent/memory/citations/list", agentMemoryCitationsListRoute);
orgScoped.route("/agent/memory/citations/stats", agentMemoryCitationStatsRoute);
orgScoped.route("/agent/memory", agentMemoryWriteRoute);
orgScoped.route("/agent/approvals/resolve", agentApprovalResolveRoute);
orgScoped.route("/agent/execution/record", agentExecutionRecordRoute);
// Agent run-trace span tree: one execution plus its steps and tool calls. The
// list route backs the Activity index.
orgScoped.route("/agent/executions", agentExecutionListRoute);
orgScoped.route("/agent/trace", agentTraceGetRoute);
orgScoped.route("/agent/debug/trace", agentDebugTraceRoute);
// Fleet-wide error triage overview — clusters ClickHouse error_events by
// fingerprint. Pure SQL (ADR-021 §1), the counterpart to agent/debug/trace's
// single-execution failure frame above.
orgScoped.route("/telemetry/error/cluster", telemetryErrorClusterRoute);
// Provider capability posture matrix — what a BYOK-configured vendor actually
// supports (cache opt-in vs implicit, reasoning control, structured output,
// attachments) before work is routed to it.
orgScoped.route("/model/capabilities", modelCapabilityListRoute);
// Agent lifecycle: definitions, deployment, triggers. The /update and /publish
// sub-paths are mounted before the get route so they are not swallowed by its
// GET /:agentId param match.
orgScoped.route("/agent/definitions/update", agentDefinitionUpdateRoute);
orgScoped.route("/agent/definitions/publish", agentDefinitionPublishRoute);
orgScoped.route("/agent/definitions/suggest", agentDefinitionSuggestRoute);
orgScoped.route("/agent/definitions/revise", agentDefinitionReviseRoute);
orgScoped.route("/agent/definitions/summarize", agentDefinitionSummarizeRoute);
orgScoped.route("/agent/definitions/delete", agentDefinitionDeleteRoute);
orgScoped.route("/agent/definitions", agentDefinitionCreateRoute);
orgScoped.route("/agent/definitions", agentDefinitionListRoute);
orgScoped.route("/agent/definitions", agentDefinitionGetRoute);
// Agent RBAC role assignment (docs/specs/agent-rbac/spec.md §3.2): attach/
// detach/inspect IAM roles on an agent's delegated principal. The /assign,
// /revoke and /get sub-paths are mounted before the base list route so its
// GET / never swallows them.
orgScoped.route("/agent/roles/assign", agentRoleAssignRoute);
orgScoped.route("/agent/roles/revoke", agentRoleRevokeRoute);
orgScoped.route("/agent/roles/get", agentRoleGetRoute);
orgScoped.route("/agent/roles", agentRoleListRoute);
orgScoped.route("/agent/deploy", agentDeployRoute);
// Verified-Outcome Market Router governance + inspection.
orgScoped.route("/router/policy/set", routerPolicySetRoute);
orgScoped.route("/router/policy", routerPolicyGetRoute);
orgScoped.route("/router/stats", routerStatsListRoute);
orgScoped.route("/router/preview", routerDecisionPreviewRoute);
orgScoped.route("/command/menu/search", commandMenuSearchRoute);
orgScoped.route("/command/menu/suggest", commandMenuSuggestRoute);
orgScoped.route("/reference/search", referenceSearchRoute);
orgScoped.route("/system/install-instructions", systemInstallInstructionsRoute);
orgScoped.route("/org/members", orgMemberAddRoute);
orgScoped.route("/org/members/remove", orgMemberRemoveRoute);
orgScoped.route("/org/members/role", orgMemberRoleChangeRoute);
orgScoped.route("/org/invitations/accept", orgMemberInviteAcceptRoute);
orgScoped.route("/org/invitations/decline", orgMemberInviteDeclineRoute);
orgScoped.route("/workspace/budget-policy", workspaceBudgetPolicyReadRoute);
orgScoped.route("/workspace/budget-policy", workspaceBudgetPolicyWriteRoute);
// Hard period-to-date spend ceilings (org + workspace, OXA-1079).
orgScoped.route("/billing/budget", billingBudgetGetRoute);
orgScoped.route("/billing/budget", billingBudgetSetRoute);
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
orgScoped.route("/org/data-plane", orgDataPlaneRoute);
orgScoped.route("/org/model-credential", orgModelCredentialRoute);
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
// Agent ↔ environment bindings.
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
orgScoped.route("/workspace/member/list", workspaceMemberListRoute);
orgScoped.route("/workspace/invite/send", workspaceInviteSendRoute);
orgScoped.route("/conversation/chat", conversationChatRoute);
orgScoped.route("/tool/declaration/publish", toolDeclarationPublishRoute);
orgScoped.route("/tool/declaration/list", toolDeclarationListRoute);
orgScoped.route("/context/record/publish", contextRecordPublishRoute);
orgScoped.route("/context/record/list", contextRecordListRoute);
orgScoped.route("/context/record/promote", contextRecordPromoteRoute);
orgScoped.route("/privacy/export", privacyDataExportRoute);
orgScoped.route("/privacy/erase", privacyDataEraseRoute);
orgScoped.route("/connections", connectionRoute);
// GitHub App OAuth endpoints (workspace-scoped + auth-required)
orgScoped.route("/connections/github", githubOauthRoute);
orgScoped.route("/graph/node/get", graphNodeGetRoute);
orgScoped.route("/graph/node/search", graphNodeSearchRoute);
orgScoped.route("/graph/search", graphSearchRoute);
orgScoped.route("/repos", repoRoute);
orgScoped.route("/integrations", integrationRoute);
orgScoped.route("/schema", schemaRoute);
orgScoped.route("/plugin-schema", pluginSchemaRoute);
orgScoped.route("/plugin-versions", pluginVersionRoute);
orgScoped.route("/graph/nodes", graphNodeListRoute);
orgScoped.route("/graph/stats", graphStatsRoute);
orgScoped.route("/ontology/query", ontologyQueryRoute);
orgScoped.route("/ontology/neighbors", ontologyNeighborsRoute);
orgScoped.route("/audit/log/query", auditLogQueryRoute);
// Creating a workspace needs an org and cannot need a workspace: the caller is
// asking for their first one. Mounted only under the workspace-scoped group, the
// REST surface could not take a new account past org creation — every attempt
// 404'd in workspaceMiddleware before the handler ran, so a non-browser client
// had to drive the web UI or write rows by hand (#1203).
//
// The workspace-scoped mount above stays. Creating a workspace while scoped to
// another one is an odd shape, but it is a path clients may already call, and
// this change is about opening the bootstrap route rather than closing that one.
const orgOnlyScoped = new Hono<AppEnv>();
orgOnlyScoped.use("*", authMiddleware, orgMiddleware);
orgOnlyScoped.route("/workspaces", workspaceCreateRoute);
app.route("/v1/:org_slug", orgOnlyScoped);

app.route("/v1/:org_slug/:workspace_slug", orgScoped);

// Public OAuth callback — HMAC-verified state param is the security boundary.
// Must NOT be inside the workspace-scoped group (user has no session when GitHub redirects).
app.route("/oauth/github", githubOauthCallbackRoute);

import { Hono } from "hono";
import type { CapabilityContext } from "@oxagen/oxagen";
import { requestLogger } from "./middleware/logger";
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
import { agentToolListRoute } from "./routes/v1/agent.tool.list";
import { agentMcpRegisterRoute } from "./routes/v1/agent.mcp.register";
import { agentMcpListRoute } from "./routes/v1/agent.mcp.list";
import { agentSkillListRoute } from "./routes/v1/agent.skill.list";
import { agentPlanApproveRoute } from "./routes/v1/agent.plan.approve";
import { agentTaskBackgroundStartRoute } from "./routes/v1/agent.task.background.start";
import { agentTaskBackgroundReadRoute } from "./routes/v1/agent.task.background.read";
import { agentTaskBackgroundCancelRoute } from "./routes/v1/agent.task.background.cancel";
import { agentMemoryRecallRoute } from "./routes/v1/agent.memory.recall";
import { agentMemoryWriteRoute } from "./routes/v1/agent.memory.write";
import { agentApprovalResolveRoute } from "./routes/v1/agent.approval.resolve";
import { formFillRoute } from "./routes/v1/form.fill";
import { documentsGenerateRoute } from "./routes/v1/documents.generate";
import { documentsPdfCreateRoute } from "./routes/v1/documents.pdf.create";
import { brandkitApplyRoute } from "./routes/v1/brandkit.apply";
import { videoGenerateRoute } from "./routes/v1/video.generate";
import { svgGenerateRoute } from "./routes/v1/svg.generate";
import { imageGenerateRoute } from "./routes/v1/image.generate";
import { systemInstallInstructionsRoute } from "./routes/v1/system.install.instructions";
import { orgMemberAddRoute } from "./routes/v1/org.member.add";
import { orgMemberInviteAcceptRoute } from "./routes/v1/org.member.invite.accept";
import { orgMemberInviteDeclineRoute } from "./routes/v1/org.member.invite.decline";
import { orgMemberRemoveRoute } from "./routes/v1/org.member.remove";
import { orgMemberRoleChangeRoute } from "./routes/v1/org.member.role.change";
import { filesServeRoute } from "./routes/v1/files.serve";
import { userPreferencesReadRoute } from "./routes/v1/user.preferences.read";
import { userPreferencesWriteRoute } from "./routes/v1/user.preferences.write";
import { workspaceModelSettingsReadRoute } from "./routes/v1/workspace.model.settings.read";
import { workspaceModelSettingsWriteRoute } from "./routes/v1/workspace.model.settings.write";
import { conversationListRoute } from "./routes/v1/conversation.list";
import { conversationRenameRoute } from "./routes/v1/conversation.rename";
import { conversationArchiveRoute } from "./routes/v1/conversation.archive";
import { conversationDeleteRoute } from "./routes/v1/conversation.delete";
import { conversationPurgeRoute } from "./routes/v1/conversation.purge";
import { assetUploadRoute } from "./routes/v1/asset.upload";
import { pluginRegistryListRoute } from "./routes/v1/plugin.registry.list";
import { pluginRegistryAddRoute } from "./routes/v1/plugin.registry.add";
import { pluginRegistryRemoveRoute } from "./routes/v1/plugin.registry.remove";
import { pluginRegistrySyncRoute } from "./routes/v1/plugin.registry.sync";
import { pluginCatalogBrowseRoute } from "./routes/v1/plugin.catalog.browse";
import { pluginCatalogGetRoute } from "./routes/v1/plugin.catalog.get";
import { pluginOrgInstallRoute } from "./routes/v1/plugin.org.install";
import { pluginOrgInstallBulkRoute } from "./routes/v1/plugin.org.install_bulk";
import { pluginOrgUninstallRoute } from "./routes/v1/plugin.org.uninstall";
import { pluginOrgSetEnabledRoute } from "./routes/v1/plugin.org.set_enabled";
import { pluginDenylistAddRoute } from "./routes/v1/plugin.denylist.add";
import { pluginDenylistRemoveRoute } from "./routes/v1/plugin.denylist.remove";
import { pluginWorkspaceSetEnabledRoute } from "./routes/v1/plugin.workspace.set_enabled";
import { pluginCredentialSetSecretRoute } from "./routes/v1/plugin.credential.set_secret";

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
app.onError(errorMiddleware);

// Public routes — health and Stripe webhook bypass auth. The webhook needs
// the raw body for signature verification and is its own auth surface.
app.route("/health", health);
app.route("/webhooks/stripe", stripeWebhook);
// Inngest cloud polls /api/inngest for the function manifest; signing-key
// verification is enforced inside the inngest/hono serve handler.
app.route("/api/inngest", inngestRoute);

// /v1 user-level routes (org + workspace CRUD) require auth but no
// org scope: a freshly-authenticated user can create their first
// org without one existing.
const userScoped = new Hono<AppEnv>();
userScoped.use("*", authMiddleware);
userScoped.route("/organizations", organizationCreateRoute);
userScoped.route("/user/preferences", userPreferencesReadRoute);
userScoped.route("/user/preferences", userPreferencesWriteRoute);
app.route("/v1", userScoped);

// /v1/:org_slug/:workspace_slug/* — org + workspace scoped routes.
const orgScoped = new Hono<AppEnv>();
orgScoped.use("*", authMiddleware, orgMiddleware, workspaceMiddleware);
orgScoped.route("/workspaces", workspaceCreateRoute);
orgScoped.route("/billing/subscription", billingSubscriptionReadRoute);
orgScoped.route("/billing/subscription/upgrade/start", billingSubscriptionUpgradeStartRoute);
orgScoped.route("/billing/credits/purchase", billingCreditsPurchaseRoute);
orgScoped.route("/chat/messages", chatMessageSendRoute);
orgScoped.route("/conversations", conversationListRoute);
orgScoped.route("/conversations/rename", conversationRenameRoute);
orgScoped.route("/conversations/archive", conversationArchiveRoute);
orgScoped.route("/conversations/delete", conversationDeleteRoute);
orgScoped.route("/conversations/purge", conversationPurgeRoute);
// Agent-runtime routes live under the org + workspace scope so the runner
// inherits the same auth, isolation, and audit envelope as every other v1 call.
orgScoped.route("/agent/tools", agentToolListRoute);
orgScoped.route("/agent/mcp-servers", agentMcpRegisterRoute);
orgScoped.route("/agent/mcp-servers", agentMcpListRoute);
orgScoped.route("/agent/skills", agentSkillListRoute);
orgScoped.route("/agent/plans/approve", agentPlanApproveRoute);
orgScoped.route("/agent/tasks", agentTaskBackgroundStartRoute);
orgScoped.route("/agent/tasks", agentTaskBackgroundReadRoute);
orgScoped.route("/agent/tasks/cancel", agentTaskBackgroundCancelRoute);
orgScoped.route("/agent/memory/recall", agentMemoryRecallRoute);
orgScoped.route("/agent/memory", agentMemoryWriteRoute);
orgScoped.route("/agent/approvals/resolve", agentApprovalResolveRoute);
orgScoped.route("/forms/fill", formFillRoute);
orgScoped.route("/documents/generate", documentsGenerateRoute);
orgScoped.route("/documents/pdf", documentsPdfCreateRoute);
orgScoped.route("/brandkit/apply", brandkitApplyRoute);
orgScoped.route("/video/generate", videoGenerateRoute);
orgScoped.route("/svg/generate", svgGenerateRoute);
orgScoped.route("/image/generate", imageGenerateRoute);
orgScoped.route("/system/install-instructions", systemInstallInstructionsRoute);
orgScoped.route("/org/members", orgMemberAddRoute);
orgScoped.route("/org/members/remove", orgMemberRemoveRoute);
orgScoped.route("/org/members/role", orgMemberRoleChangeRoute);
orgScoped.route("/org/invitations/accept", orgMemberInviteAcceptRoute);
orgScoped.route("/org/invitations/decline", orgMemberInviteDeclineRoute);
orgScoped.route("/files", filesServeRoute);
orgScoped.route("/workspace/model-settings", workspaceModelSettingsReadRoute);
orgScoped.route("/workspace/model-settings", workspaceModelSettingsWriteRoute);
orgScoped.route("/asset/upload", assetUploadRoute);
orgScoped.route("/plugin/registries", pluginRegistryListRoute);
orgScoped.route("/plugin/registries/add", pluginRegistryAddRoute);
orgScoped.route("/plugin/registries/remove", pluginRegistryRemoveRoute);
orgScoped.route("/plugin/registries/sync", pluginRegistrySyncRoute);
orgScoped.route("/plugin/catalog/browse", pluginCatalogBrowseRoute);
orgScoped.route("/plugin/catalog/get", pluginCatalogGetRoute);
orgScoped.route("/plugin/org/install", pluginOrgInstallRoute);
orgScoped.route("/plugin/org/install-bulk", pluginOrgInstallBulkRoute);
orgScoped.route("/plugin/org/uninstall", pluginOrgUninstallRoute);
orgScoped.route("/plugin/org/set-enabled", pluginOrgSetEnabledRoute);
orgScoped.route("/plugin/denylist/add", pluginDenylistAddRoute);
orgScoped.route("/plugin/denylist/remove", pluginDenylistRemoveRoute);
orgScoped.route("/plugin/workspace/set-enabled", pluginWorkspaceSetEnabledRoute);
orgScoped.route("/plugin/credential/set-secret", pluginCredentialSetSecretRoute);
app.route("/v1/:org_slug/:workspace_slug", orgScoped);

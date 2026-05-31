import { Hono } from "hono";
import type { CapabilityContext } from "@oxagen/oxagen";
import { requestLogger } from "./middleware/logger.js";
import { errorMiddleware } from "./middleware/error.js";
import { authMiddleware } from "./middleware/auth.js";
import { orgMiddleware } from "./middleware/org.js";
import { workspaceMiddleware } from "./middleware/workspace.js";
import { health } from "./routes/health.js";
import { stripeWebhook } from "./routes/stripe.js";
import { inngestRoute } from "./routes/inngest.js";
import { organizationCreateRoute } from "./routes/v1/organization.create.js";
import { workspaceCreateRoute } from "./routes/v1/workspace.create.js";
import { billingSubscriptionReadRoute } from "./routes/v1/billing.subscription.read.js";
import { billingSubscriptionUpgradeStartRoute } from "./routes/v1/billing.subscription.upgrade.start.js";
import { chatMessageSendRoute } from "./routes/v1/chat.message.send.js";
import { agentToolListRoute } from "./routes/v1/agent.tool.list.js";
import { agentMcpRegisterRoute } from "./routes/v1/agent.mcp.register.js";
import { agentMcpListRoute } from "./routes/v1/agent.mcp.list.js";
import { agentSkillListRoute } from "./routes/v1/agent.skill.list.js";
import { agentPlanApproveRoute } from "./routes/v1/agent.plan.approve.js";
import { agentTaskBackgroundStartRoute } from "./routes/v1/agent.task.background.start.js";
import { agentTaskBackgroundReadRoute } from "./routes/v1/agent.task.background.read.js";
import { agentTaskBackgroundCancelRoute } from "./routes/v1/agent.task.background.cancel.js";
import { agentMemoryRecallRoute } from "./routes/v1/agent.memory.recall.js";
import { agentMemoryWriteRoute } from "./routes/v1/agent.memory.write.js";
import { agentApprovalResolveRoute } from "./routes/v1/agent.approval.resolve.js";
import { formFillRoute } from "./routes/v1/form.fill.js";

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
app.route("/v1", userScoped);

// /v1/:org_slug/:workspace_slug/* — org + workspace scoped routes.
const orgScoped = new Hono<AppEnv>();
orgScoped.use("*", authMiddleware, orgMiddleware, workspaceMiddleware);
orgScoped.route("/workspaces", workspaceCreateRoute);
orgScoped.route("/billing/subscription", billingSubscriptionReadRoute);
orgScoped.route("/billing/subscription/upgrade/start", billingSubscriptionUpgradeStartRoute);
orgScoped.route("/chat/messages", chatMessageSendRoute);
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
app.route("/v1/:org_slug/:workspace_slug", orgScoped);

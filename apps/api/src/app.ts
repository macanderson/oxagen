import { Hono } from "hono";
import type { CapabilityContext } from "@oxagen/oxagen";
import { requestLogger } from "./middleware/logger.js";
import { errorMiddleware } from "./middleware/error.js";
import { authMiddleware } from "./middleware/auth.js";
import { tenantMiddleware } from "./middleware/tenant.js";
import { workspaceMiddleware } from "./middleware/workspace.js";
import { health } from "./routes/health.js";
import { stripeWebhook } from "./routes/stripe.js";
import { tenantCreateRoute } from "./routes/v1/tenant.create.js";
import { workspaceCreateRoute } from "./routes/v1/workspace.create.js";
import { billingSubscriptionReadRoute } from "./routes/v1/billing.subscription.read.js";
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

export type AppEnv = {
  Variables: {
    requestId: string;
    userId: string | null;
    apiKeyId: string | null;
    tenantId: string | null;
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

// /v1 user-level routes (tenant + workspace CRUD) require auth but no
// tenant scope: a freshly-authenticated user can create their first
// tenant without one existing.
const userScoped = new Hono<AppEnv>();
userScoped.use("*", authMiddleware);
userScoped.route("/tenants", tenantCreateRoute);
app.route("/v1", userScoped);

// /v1/:tenant_slug/:workspace_slug/* — tenant + workspace scoped routes.
const tenantScoped = new Hono<AppEnv>();
tenantScoped.use("*", authMiddleware, tenantMiddleware, workspaceMiddleware);
tenantScoped.route("/workspaces", workspaceCreateRoute);
tenantScoped.route("/billing/subscription", billingSubscriptionReadRoute);
tenantScoped.route("/chat/messages", chatMessageSendRoute);
// Agent-runtime routes live under the tenant + workspace scope so the runner
// inherits the same auth, isolation, and audit envelope as every other v1 call.
tenantScoped.route("/agent/tools", agentToolListRoute);
tenantScoped.route("/agent/mcp-servers", agentMcpRegisterRoute);
tenantScoped.route("/agent/mcp-servers", agentMcpListRoute);
tenantScoped.route("/agent/skills", agentSkillListRoute);
tenantScoped.route("/agent/plans/approve", agentPlanApproveRoute);
tenantScoped.route("/agent/tasks", agentTaskBackgroundStartRoute);
tenantScoped.route("/agent/tasks", agentTaskBackgroundReadRoute);
tenantScoped.route("/agent/tasks/cancel", agentTaskBackgroundCancelRoute);
tenantScoped.route("/agent/memory/recall", agentMemoryRecallRoute);
tenantScoped.route("/agent/memory", agentMemoryWriteRoute);
tenantScoped.route("/agent/approvals/resolve", agentApprovalResolveRoute);
app.route("/v1/:tenant_slug/:workspace_slug", tenantScoped);

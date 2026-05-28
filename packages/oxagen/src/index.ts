export * from "./types.js";
export * from "./registry.js";

// Capabilities auto-register on import. Order doesn't matter — the
// registry deduplicates and the manifest gate verifies layer presence.

// Foundation
import "./capabilities/tenant.create.js";
import "./capabilities/workspace.create.js";
import "./capabilities/billing.subscription.read.js";
import "./capabilities/chat.message.send.js";

// Agent runtime
import "./capabilities/agent.tool.list.js";
import "./capabilities/agent.subagent.dispatch.js";
import "./capabilities/agent.subagent.aggregate.js";
import "./capabilities/agent.code.execute.js";
import "./capabilities/agent.mcp.register.js";
import "./capabilities/agent.mcp.list.js";
import "./capabilities/agent.skill.list.js";
import "./capabilities/agent.skill.load.js";
import "./capabilities/agent.plan.create.js";
import "./capabilities/agent.plan.approve.js";
import "./capabilities/agent.task.background.start.js";
import "./capabilities/agent.task.background.read.js";
import "./capabilities/agent.task.background.cancel.js";
import "./capabilities/agent.memory.recall.js";
import "./capabilities/agent.memory.write.js";
import "./capabilities/agent.approval.resolve.js";

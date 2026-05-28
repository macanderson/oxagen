export * from "./types.js";
export * from "./registry.js";

// Capabilities auto-register on import. Order doesn't matter — the
// registry deduplicates and the manifest gate verifies layer presence.

// Foundation
import "./contracts/tenant.create.js";
import "./contracts/workspace.create.js";
import "./contracts/billing.subscription.read.js";
import "./contracts/billing.subscription.upgrade.start.js";
import "./contracts/chat.message.send.js";

// Agent runtime
import "./contracts/agent.tool.list.js";
import "./contracts/agent.subagent.dispatch.js";
import "./contracts/agent.subagent.aggregate.js";
import "./contracts/agent.code.execute.js";
import "./contracts/agent.mcp.register.js";
import "./contracts/agent.mcp.list.js";
import "./contracts/agent.skill.list.js";
import "./contracts/agent.skill.load.js";
import "./contracts/agent.plan.create.js";
import "./contracts/agent.plan.approve.js";
import "./contracts/agent.task.background.start.js";
import "./contracts/agent.task.background.read.js";
import "./contracts/agent.task.background.cancel.js";
import "./contracts/agent.memory.recall.js";
import "./contracts/agent.memory.write.js";
import "./contracts/agent.approval.resolve.js";

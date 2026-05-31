// contracts/index.ts — canonical per-package contracts array (OXA-1390, Phase 3).
//
// Every capability registered via registerCapability() in this package is re-exported here.
// The array is the canonical registry for tooling that needs to discover capabilities
// (seed migration, check-contracts.mjs CI guard, Wave 5 access UI). Adding a
// new contract file requires a corresponding entry here.
//
// Note: these imports trigger the registerCapability() side-effects inside
// each file, so this barrel also serves as the registration entrypoint.

import { agentApprovalResolve } from "./agent.approval.resolve.js";
import { agentCodeExecute } from "./agent.code.execute.js";
import { brandkitApply } from "./brandkit.apply.js";
import { documentsGenerate } from "./documents.generate.js";
import { documentsPdfCreate } from "./documents.pdf.create.js";
import { agentMcpList } from "./agent.mcp.list.js";
import { agentMcpRegister } from "./agent.mcp.register.js";
import { agentMemoryRecall } from "./agent.memory.recall.js";
import { agentMemoryWrite } from "./agent.memory.write.js";
import { agentPlanApprove } from "./agent.plan.approve.js";
import { agentPlanCreate } from "./agent.plan.create.js";
import { agentSkillList } from "./agent.skill.list.js";
import { agentSkillLoad } from "./agent.skill.load.js";
import { agentSubagentAggregate } from "./agent.subagent.aggregate.js";
import { agentSubagentDispatch } from "./agent.subagent.dispatch.js";
import { agentTaskBackgroundCancel } from "./agent.task.background.cancel.js";
import { agentTaskBackgroundRead } from "./agent.task.background.read.js";
import { agentTaskBackgroundStart } from "./agent.task.background.start.js";
import { agentToolList } from "./agent.tool.list.js";
import { billingSubscriptionRead } from "./billing.subscription.read.js";
import { billingSubscriptionUpgradeStart } from "./billing.subscription.upgrade.start.js";
import { chatMessageSend } from "./chat.message.send.js";
import { formFill } from "./form.fill.js";
import { organizationCreate } from "./organization.create.js";
import { workspaceCreate } from "./workspace.create.js";
import { videoGenerate } from "./video.generate.js";

export {
  agentApprovalResolve,
  agentCodeExecute,
  brandkitApply,
  documentsGenerate,
  documentsPdfCreate,
  agentMcpList,
  agentMcpRegister,
  agentMemoryRecall,
  agentMemoryWrite,
  agentPlanApprove,
  agentPlanCreate,
  agentSkillList,
  agentSkillLoad,
  agentSubagentAggregate,
  agentSubagentDispatch,
  agentTaskBackgroundCancel,
  agentTaskBackgroundRead,
  agentTaskBackgroundStart,
  agentToolList,
  billingSubscriptionRead,
  billingSubscriptionUpgradeStart,
  chatMessageSend,
  formFill,
  organizationCreate,
  workspaceCreate,
  videoGenerate,
};

/**
 * The canonical contracts array for this package. Used by:
 *   - tools/scripts/check-contracts.mjs (CI guard)
 *   - tools/scripts/seed-iam-defaults.ts (seed migration)
 *   - Wave 5 access matrix UI
 *
 * Add one entry here whenever a new contract file is added to this directory.
 */
export const contracts = [
  agentApprovalResolve,
  brandkitApply,
  documentsGenerate,
  documentsPdfCreate,
  agentCodeExecute,
  agentMcpList,
  agentMcpRegister,
  agentMemoryRecall,
  agentMemoryWrite,
  agentPlanApprove,
  agentPlanCreate,
  agentSkillList,
  agentSkillLoad,
  agentSubagentAggregate,
  agentSubagentDispatch,
  agentTaskBackgroundCancel,
  agentTaskBackgroundRead,
  agentTaskBackgroundStart,
  agentToolList,
  billingSubscriptionRead,
  billingSubscriptionUpgradeStart,
  chatMessageSend,
  formFill,
  organizationCreate,
  workspaceCreate,
  videoGenerate,
] as const;

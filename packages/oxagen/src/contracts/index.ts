// contracts/index.ts — canonical per-package contracts array (OXA-1390, Phase 3).
//
// Every capability registered via registerCapability() in this package is re-exported here.
// The array is the canonical registry for tooling that needs to discover capabilities
// (seed migration, check-contracts.mjs CI guard, Wave 5 access UI). Adding a
// new contract file requires a corresponding entry here.
//
// Note: these imports trigger the registerCapability() side-effects inside
// each file, so this barrel also serves as the registration entrypoint.

import { agentApprovalResolve } from "./agent.approval.resolve";
import { agentCodeExecute } from "./agent.code.execute";
import { brandkitApply } from "./brandkit.apply";
import { documentsGenerate } from "./documents.generate";
import { documentsPdfCreate } from "./documents.pdf.create";
import { agentMcpList } from "./agent.mcp.list";
import { agentMcpRegister } from "./agent.mcp.register";
import { agentMemoryRecall } from "./agent.memory.recall";
import { agentMemoryWrite } from "./agent.memory.write";
import { agentPlanApprove } from "./agent.plan.approve";
import { agentPlanCreate } from "./agent.plan.create";
import { agentSkillList } from "./agent.skill.list";
import { agentSkillLoad } from "./agent.skill.load";
import { agentSubagentAggregate } from "./agent.subagent.aggregate";
import { agentSubagentDispatch } from "./agent.subagent.dispatch";
import { agentTaskBackgroundCancel } from "./agent.task.background.cancel";
import { agentTaskBackgroundRead } from "./agent.task.background.read";
import { agentTaskBackgroundStart } from "./agent.task.background.start";
import { agentToolList } from "./agent.tool.list";
import { billingCreditsPurchase } from "./billing.credits.purchase";
import { billingSubscriptionRead } from "./billing.subscription.read";
import { billingSubscriptionUpgradeStart } from "./billing.subscription.upgrade.start";
import { chatMessageSend } from "./chat.message.send";
import { formFill } from "./form.fill";
import { organizationCreate } from "./organization.create";
import { orgMemberAdd } from "./org.member.add";
import { orgMemberInviteAccept } from "./org.member.invite.accept";
import { orgMemberInviteDecline } from "./org.member.invite.decline";
import { workspaceCreate } from "./workspace.create";
import { videoGenerate } from "./video.generate";
import { imageGenerate } from "./image.generate";
import { svgGenerate } from "./svg.generate";
import { systemInstallInstructions } from "./system.install.instructions";
import { userPreferencesRead } from "./user.preferences.read";
import { userPreferencesWrite } from "./user.preferences.write";
import { workspaceModelSettingsRead } from "./workspace.model.settings.read";
import { workspaceModelSettingsWrite } from "./workspace.model.settings.write";

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
  billingCreditsPurchase,
  billingSubscriptionRead,
  billingSubscriptionUpgradeStart,
  chatMessageSend,
  formFill,
  organizationCreate,
  orgMemberAdd,
  orgMemberInviteAccept,
  orgMemberInviteDecline,
  workspaceCreate,
  videoGenerate,
  imageGenerate,
  svgGenerate,
  systemInstallInstructions,
  userPreferencesRead,
  userPreferencesWrite,
  workspaceModelSettingsRead,
  workspaceModelSettingsWrite,
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
  billingCreditsPurchase,
  billingSubscriptionRead,
  billingSubscriptionUpgradeStart,
  chatMessageSend,
  formFill,
  organizationCreate,
  orgMemberAdd,
  orgMemberInviteAccept,
  orgMemberInviteDecline,
  workspaceCreate,
  videoGenerate,
  imageGenerate,
  svgGenerate,
  systemInstallInstructions,
  userPreferencesRead,
  userPreferencesWrite,
  workspaceModelSettingsRead,
  workspaceModelSettingsWrite,
] as const;

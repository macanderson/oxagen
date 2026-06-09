// contracts/index.ts — canonical per-package contracts array (OXA-1390, Phase 3).
//
// Every capability registered via registerCapability() in this package is re-exported here.
// The array is the canonical registry for tooling that needs to discover capabilities
// (seed migration, check-contracts.mjs CI guard, Wave 5 access UI). Adding a
// new contract file requires a corresponding entry here.
//
// Note: these imports trigger the registerCapability() side-effects inside
// each file, so this barrel also serves as the registration entrypoint.

import { apiKeyCreate } from "./api.key.create";
import { apiKeyRevoke } from "./api.key.revoke";
import { archiveCreate } from "./archive.create";
import { assetUpload } from "./asset.upload";
import { agentApprovalResolve } from "./agent.approval.resolve";
import { agentExecutionRecord } from "./agent.execution.record";
import { brandkitApply } from "./brandkit.apply";
import { documentsGenerate } from "./documents.generate";
import { documentsPdfCreate } from "./documents.pdf.create";
import { agentMcpList } from "./agent.mcp.list";
import { agentMcpRegister } from "./agent.mcp.register";
import { agentMemoryRecall } from "./agent.memory.recall";
import { agentMemoryWrite } from "./agent.memory.write";
import { agentPlanApprove } from "./agent.plan.approve";
import { agentSkillList } from "./agent.skill.list";
import { agentTaskBackgroundCancel } from "./agent.task.background.cancel";
import { agentTaskBackgroundRead } from "./agent.task.background.read";
import { agentTaskBackgroundStart } from "./agent.task.background.start";
import { agentToolList } from "./agent.tool.list";
import { billingCreditsPurchase } from "./billing.credits.purchase";
import { billingSubscriptionRead } from "./billing.subscription.read";
import { billingSubscriptionUpgradeStart } from "./billing.subscription.upgrade.start";
import { chatMessageExecution } from "./chat.message.execution";
import { chatMessageSend } from "./chat.message.send";
import { conversationArchive } from "./conversation.archive";
import { conversationDelete } from "./conversation.delete";
import { conversationList } from "./conversation.list";
import { conversationPurge } from "./conversation.purge";
import { conversationRename } from "./conversation.rename";
import { formFill } from "./form.fill";
import { organizationCreate } from "./organization.create";
import { orgMemberAdd } from "./org.member.add";
import { orgMemberInviteAccept } from "./org.member.invite.accept";
import { orgMemberInviteDecline } from "./org.member.invite.decline";
import { orgMemberRemove } from "./org.member.remove";
import { orgMemberRoleChange } from "./org.member.role.change";
import { workspaceCreate } from "./workspace.create";
import { videoGenerate } from "./video.generate";
import { imageGenerate } from "./image.generate";
import { svgGenerate } from "./svg.generate";
import { systemInstallInstructions } from "./system.install.instructions";
import { userPreferencesRead } from "./user.preferences.read";
import { userPreferencesWrite } from "./user.preferences.write";
import { workspaceModelSettingsRead } from "./workspace.model.settings.read";
import { workspaceModelSettingsWrite } from "./workspace.model.settings.write";
import { promptSettingsRead } from "./prompt.settings.read";
import { promptSettingsWrite } from "./prompt.settings.write";
import { notificationsList } from "./notifications.list";
import { notificationsMark } from "./notifications.mark";
import { pluginCatalogBrowse } from "./plugin.catalog.browse";
import { pluginCatalogGet } from "./plugin.catalog.get";
import { pluginCredentialReauth } from "./plugin.credential.reauth";
import { pluginCredentialSetSecret } from "./plugin.credential.set_secret";
import { pluginDenylistAdd } from "./plugin.denylist.add";
import { pluginDenylistRemove } from "./plugin.denylist.remove";
import { pluginOrgInstall } from "./plugin.org.install";
import { pluginOrgInstallBulk } from "./plugin.org.install_bulk";
import { pluginOrgList } from "./plugin.org.list";
import { pluginOrgSetEnabled } from "./plugin.org.set_enabled";
import { pluginOrgUninstall } from "./plugin.org.uninstall";
import { pluginRegistryAdd } from "./plugin.registry.add";
import { pluginRegistryList } from "./plugin.registry.list";
import { pluginRegistryRemove } from "./plugin.registry.remove";
import { pluginRegistrySync } from "./plugin.registry.sync";
import { pluginSettingsSetAuthAlerts } from "./plugin.settings.set_auth_alerts";
import { pluginWorkspaceSetEnabled } from "./plugin.workspace.set_enabled";
import { workflowRun } from "./workflow.run";
import { workflowStatus } from "./workflow.status";
import { workflowCancel } from "./workflow.cancel";
import { conversationChat } from "./conversation.chat";
import { imageCreate } from "./image.create";
import { imageList } from "./image.list";
import { imageAnalyze } from "./image.analyze";
import { documentCreate } from "./document.create";
import { documentList } from "./document.list";
import { documentRead } from "./document.read";
import { formCreate } from "./form.create";
import { formSubmit } from "./form.submit";
import { automationList } from "./automation.list";
import { automationCreate } from "./automation.create";
import { automationTrigger } from "./automation.trigger";
import { workspaceMemberList } from "./workspace.member.list";
import { workspaceInviteSend } from "./workspace.invite.send";
import { skillWorkspaceList } from "./skill.workspace.list";

export {
  apiKeyCreate,
  apiKeyRevoke,
  archiveCreate,
  assetUpload,
  agentApprovalResolve,
  agentExecutionRecord,
  brandkitApply,
  documentsGenerate,
  documentsPdfCreate,
  agentMcpList,
  agentMcpRegister,
  agentMemoryRecall,
  agentMemoryWrite,
  agentPlanApprove,
  agentSkillList,
  agentTaskBackgroundCancel,
  agentTaskBackgroundRead,
  agentTaskBackgroundStart,
  agentToolList,
  billingCreditsPurchase,
  billingSubscriptionRead,
  billingSubscriptionUpgradeStart,
  chatMessageExecution,
  chatMessageSend,
  conversationArchive,
  conversationDelete,
  conversationList,
  conversationPurge,
  conversationRename,
  formFill,
  organizationCreate,
  orgMemberAdd,
  orgMemberInviteAccept,
  orgMemberInviteDecline,
  orgMemberRemove,
  orgMemberRoleChange,
  workspaceCreate,
  videoGenerate,
  imageGenerate,
  svgGenerate,
  systemInstallInstructions,
  userPreferencesRead,
  userPreferencesWrite,
  workspaceModelSettingsRead,
  workspaceModelSettingsWrite,
  promptSettingsRead,
  promptSettingsWrite,
  notificationsList,
  notificationsMark,
  pluginCatalogBrowse,
  pluginCatalogGet,
  pluginCredentialReauth,
  pluginCredentialSetSecret,
  pluginDenylistAdd,
  pluginDenylistRemove,
  pluginOrgInstall,
  pluginOrgInstallBulk,
  pluginOrgList,
  pluginOrgSetEnabled,
  pluginOrgUninstall,
  pluginRegistryAdd,
  pluginRegistryList,
  pluginRegistryRemove,
  pluginRegistrySync,
  pluginSettingsSetAuthAlerts,
  pluginWorkspaceSetEnabled,
  workflowRun,
  workflowStatus,
  workflowCancel,
  conversationChat,
  imageCreate,
  imageList,
  imageAnalyze,
  documentCreate,
  documentList,
  documentRead,
  formCreate,
  formSubmit,
  automationList,
  automationCreate,
  automationTrigger,
  workspaceMemberList,
  workspaceInviteSend,
  skillWorkspaceList,
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
  apiKeyCreate,
  apiKeyRevoke,
  archiveCreate,
  assetUpload,
  agentApprovalResolve,
  brandkitApply,
  documentsGenerate,
  documentsPdfCreate,
  agentMcpList,
  agentMcpRegister,
  agentMemoryRecall,
  agentMemoryWrite,
  agentPlanApprove,
  agentSkillList,
  agentTaskBackgroundCancel,
  agentTaskBackgroundRead,
  agentTaskBackgroundStart,
  agentToolList,
  billingCreditsPurchase,
  billingSubscriptionRead,
  billingSubscriptionUpgradeStart,
  chatMessageExecution,
  chatMessageSend,
  conversationArchive,
  conversationDelete,
  conversationList,
  conversationPurge,
  conversationRename,
  formFill,
  organizationCreate,
  orgMemberAdd,
  orgMemberInviteAccept,
  orgMemberInviteDecline,
  orgMemberRemove,
  orgMemberRoleChange,
  workspaceCreate,
  videoGenerate,
  imageGenerate,
  svgGenerate,
  systemInstallInstructions,
  userPreferencesRead,
  userPreferencesWrite,
  workspaceModelSettingsRead,
  workspaceModelSettingsWrite,
  promptSettingsRead,
  promptSettingsWrite,
  notificationsList,
  notificationsMark,
  pluginCatalogBrowse,
  pluginCatalogGet,
  pluginCredentialReauth,
  pluginCredentialSetSecret,
  pluginDenylistAdd,
  pluginDenylistRemove,
  pluginOrgInstall,
  pluginOrgInstallBulk,
  pluginOrgList,
  pluginOrgSetEnabled,
  pluginOrgUninstall,
  pluginRegistryAdd,
  pluginRegistryList,
  pluginRegistryRemove,
  pluginRegistrySync,
  pluginSettingsSetAuthAlerts,
  pluginWorkspaceSetEnabled,
  workflowRun,
  workflowStatus,
  workflowCancel,
  conversationChat,
  imageCreate,
  imageList,
  imageAnalyze,
  documentCreate,
  documentList,
  documentRead,
  formCreate,
  formSubmit,
  automationList,
  automationCreate,
  automationTrigger,
  workspaceMemberList,
  workspaceInviteSend,
  skillWorkspaceList,
  agentExecutionRecord,
] as const;

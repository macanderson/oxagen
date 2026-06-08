// tool-registry.test.ts — config-derived parity guard.
//
// Computes the expected set of MCP tool names by filtering the canonical
// `contracts` array from @oxagen/oxagen/contracts to those whose `surfaces`
// includes "mcp". Compares that set against the union of `metadata.name`
// values exported by every tool file in this directory.
//
// If a contract gains the "mcp" surface without a corresponding tool file,
// or if a tool file's metadata.name diverges from the contract name, this
// test fails — no stale or missing tools can ship silently.
//
// No hardcoded count; the expected set is derived from the contracts array.

import { describe, it, expect } from "vitest";
import { contracts } from "@oxagen/oxagen/contracts";

// ── Import all tool metadata ──────────────────────────────────────────────────

import { metadata as apiKeyCreateMetadata } from "./api.key.create";
import { metadata as apiKeyRevokeMetadata } from "./api.key.revoke";
import { metadata as agentApprovalResolveMetadata } from "./agent.approval.resolve";
import { metadata as archiveCreateMetadata } from "./archive.create";
import { metadata as agentMcpListMetadata } from "./agent.mcp.list";
import { metadata as agentMcpRegisterMetadata } from "./agent.mcp.register";
import { metadata as agentMemoryRecallMetadata } from "./agent.memory.recall";
import { metadata as agentMemoryWriteMetadata } from "./agent.memory.write";
import { metadata as agentPlanApproveMetadata } from "./agent.plan.approve";
import { metadata as agentSkillListMetadata } from "./agent.skill.list";
import { metadata as agentTaskBackgroundCancelMetadata } from "./agent.task.background.cancel";
import { metadata as agentTaskBackgroundReadMetadata } from "./agent.task.background.read";
import { metadata as agentTaskBackgroundStartMetadata } from "./agent.task.background.start";
import { metadata as agentToolListMetadata } from "./agent.tool.list";
import { metadata as assetUploadMetadata } from "./asset.upload";
import { metadata as billingCreditsPurchaseMetadata } from "./billing.credits.purchase";
import { metadata as billingSubscriptionReadMetadata } from "./billing.subscription.read";
import { metadata as billingSubscriptionUpgradeStartMetadata } from "./billing.subscription.upgrade.start";
import { metadata as brandkitApplyMetadata } from "./brandkit.apply";
import { metadata as chatMessageSendMetadata } from "./chat.message.send";
import { metadata as conversationArchiveMetadata } from "./conversation.archive";
import { metadata as conversationDeleteMetadata } from "./conversation.delete";
import { metadata as conversationListMetadata } from "./conversation.list";
import { metadata as conversationPurgeMetadata } from "./conversation.purge";
import { metadata as conversationRenameMetadata } from "./conversation.rename";
import { metadata as documentsGenerateMetadata } from "./documents.generate";
import { metadata as documentsPdfCreateMetadata } from "./documents.pdf.create";
import { metadata as formFillMetadata } from "./form.fill";
import { metadata as imageGenerateMetadata } from "./image.generate";
import { metadata as notificationsListMetadata } from "./notifications.list";
import { metadata as notificationsMarkMetadata } from "./notifications.mark";
import { metadata as organizationCreateMetadata } from "./organization.create";
import { metadata as pluginCatalogBrowseMetadata } from "./plugin.catalog.browse";
import { metadata as pluginCatalogGetMetadata } from "./plugin.catalog.get";
import { metadata as pluginCredentialReauthMetadata } from "./plugin.credential.reauth";
import { metadata as pluginCredentialSetSecretMetadata } from "./plugin.credential.set_secret";
import { metadata as pluginDenylistAddMetadata } from "./plugin.denylist.add";
import { metadata as pluginDenylistRemoveMetadata } from "./plugin.denylist.remove";
import { metadata as pluginOrgInstallMetadata } from "./plugin.org.install";
import { metadata as pluginOrgInstallBulkMetadata } from "./plugin.org.install_bulk";
import { metadata as pluginOrgListMetadata } from "./plugin.org.list";
import { metadata as pluginOrgSetEnabledMetadata } from "./plugin.org.set_enabled";
import { metadata as pluginOrgUninstallMetadata } from "./plugin.org.uninstall";
import { metadata as pluginRegistryAddMetadata } from "./plugin.registry.add";
import { metadata as pluginRegistryListMetadata } from "./plugin.registry.list";
import { metadata as pluginRegistryRemoveMetadata } from "./plugin.registry.remove";
import { metadata as pluginRegistrySyncMetadata } from "./plugin.registry.sync";
import { metadata as pluginSettingsSetAuthAlertsMetadata } from "./plugin.settings.set_auth_alerts";
import { metadata as pluginWorkspaceSetEnabledMetadata } from "./plugin.workspace.set_enabled";
import { metadata as orgMemberAddMetadata } from "./org.member.add";
import { metadata as orgMemberInviteAcceptMetadata } from "./org.member.invite.accept";
import { metadata as orgMemberInviteDeclineMetadata } from "./org.member.invite.decline";
import { metadata as orgMemberRemoveMetadata } from "./org.member.remove";
import { metadata as orgMemberRoleChangeMetadata } from "./org.member.role.change";
import { metadata as svgGenerateMetadata } from "./svg.generate";
import { metadata as systemInstallInstructionsMetadata } from "./system.install.instructions";
import { metadata as userPreferencesReadMetadata } from "./user.preferences.read";
import { metadata as userPreferencesWriteMetadata } from "./user.preferences.write";
import { metadata as videoGenerateMetadata } from "./video.generate";
import { metadata as workspaceCreateMetadata } from "./workspace.create";
import { metadata as workspaceModelSettingsReadMetadata } from "./workspace.model.settings.read";
import { metadata as workspaceModelSettingsWriteMetadata } from "./workspace.model.settings.write";
import { metadata as workflowRunMetadata } from "./workflow.run";
import { metadata as workflowStatusMetadata } from "./workflow.status";
import { metadata as workflowCancelMetadata } from "./workflow.cancel";
import { metadata as automationCreateMetadata } from "./automation.create";
import { metadata as automationListMetadata } from "./automation.list";
import { metadata as automationTriggerMetadata } from "./automation.trigger";
import { metadata as conversationChatMetadata } from "./conversation.chat";
import { metadata as documentCreateMetadata } from "./document.create";
import { metadata as documentListMetadata } from "./document.list";
import { metadata as documentReadMetadata } from "./document.read";
import { metadata as formCreateMetadata } from "./form.create";
import { metadata as formSubmitMetadata } from "./form.submit";
import { metadata as imageAnalyzeMetadata } from "./image.analyze";
import { metadata as imageCreateMetadata } from "./image.create";
import { metadata as imageListMetadata } from "./image.list";
import { metadata as skillWorkspaceListMetadata } from "./skill.workspace.list";
import { metadata as workspaceInviteSendMetadata } from "./workspace.invite.send";
import { metadata as workspaceMemberListMetadata } from "./workspace.member.list";

// ── Build the registered tool name list ───────────────────────────────────────

const allToolMetadata = [
  apiKeyCreateMetadata,
  apiKeyRevokeMetadata,
  agentApprovalResolveMetadata,
  agentMcpListMetadata,
  agentMcpRegisterMetadata,
  agentMemoryRecallMetadata,
  agentMemoryWriteMetadata,
  agentPlanApproveMetadata,
  agentSkillListMetadata,
  agentTaskBackgroundCancelMetadata,
  agentTaskBackgroundReadMetadata,
  agentTaskBackgroundStartMetadata,
  agentToolListMetadata,
  archiveCreateMetadata,
  assetUploadMetadata,
  billingCreditsPurchaseMetadata,
  billingSubscriptionReadMetadata,
  billingSubscriptionUpgradeStartMetadata,
  brandkitApplyMetadata,
  chatMessageSendMetadata,
  conversationArchiveMetadata,
  conversationDeleteMetadata,
  conversationListMetadata,
  conversationPurgeMetadata,
  conversationRenameMetadata,
  documentsGenerateMetadata,
  documentsPdfCreateMetadata,
  formFillMetadata,
  imageGenerateMetadata,
  notificationsListMetadata,
  notificationsMarkMetadata,
  organizationCreateMetadata,
  orgMemberAddMetadata,
  orgMemberInviteAcceptMetadata,
  orgMemberInviteDeclineMetadata,
  orgMemberRemoveMetadata,
  orgMemberRoleChangeMetadata,
  pluginCatalogBrowseMetadata,
  pluginCatalogGetMetadata,
  pluginCredentialReauthMetadata,
  pluginCredentialSetSecretMetadata,
  pluginDenylistAddMetadata,
  pluginDenylistRemoveMetadata,
  pluginOrgInstallMetadata,
  pluginOrgInstallBulkMetadata,
  pluginOrgListMetadata,
  pluginOrgSetEnabledMetadata,
  pluginOrgUninstallMetadata,
  pluginRegistryAddMetadata,
  pluginRegistryListMetadata,
  pluginRegistryRemoveMetadata,
  pluginRegistrySyncMetadata,
  pluginSettingsSetAuthAlertsMetadata,
  pluginWorkspaceSetEnabledMetadata,
  svgGenerateMetadata,
  systemInstallInstructionsMetadata,
  userPreferencesReadMetadata,
  userPreferencesWriteMetadata,
  videoGenerateMetadata,
  workspaceCreateMetadata,
  workspaceModelSettingsReadMetadata,
  workspaceModelSettingsWriteMetadata,
  workflowRunMetadata,
  workflowStatusMetadata,
  workflowCancelMetadata,
  automationCreateMetadata,
  automationListMetadata,
  automationTriggerMetadata,
  conversationChatMetadata,
  documentCreateMetadata,
  documentListMetadata,
  documentReadMetadata,
  formCreateMetadata,
  formSubmitMetadata,
  imageAnalyzeMetadata,
  imageCreateMetadata,
  imageListMetadata,
  skillWorkspaceListMetadata,
  workspaceInviteSendMetadata,
  workspaceMemberListMetadata,
];

// ── Derive expected tool set from contracts ───────────────────────────────────

/** Names derived from the contracts array for the "mcp" surface (sorted). */
const contractMcpNames = (contracts as ReadonlyArray<{ name: string; surfaces: readonly string[] }>)
  .filter((c) => c.surfaces.includes("mcp"))
  .map((c) => c.name)
  .sort();

/** Names as declared in the tool metadata (sorted). */
const registeredToolNames = allToolMetadata.map((m) => m.name).sort();

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("tool-registry parity", () => {
  it("registered tool names match the mcp-surfaced contracts exactly", () => {
    expect(registeredToolNames).toEqual(contractMcpNames);
  });

  it("each tool metadata.name matches the corresponding contract name (no copy-paste drift)", () => {
    // Build a map: contract name -> contract for O(1) lookup.
    const contractByName = new Map(
      (contracts as ReadonlyArray<{ name: string; surfaces: readonly string[] }>)
        .filter((c) => c.surfaces.includes("mcp"))
        .map((c) => [c.name, c]),
    );

    for (const meta of allToolMetadata) {
      const contract = contractByName.get(meta.name);
      expect(
        contract,
        `Tool metadata has name "${meta.name}" but no matching mcp-surfaced contract exists`,
      ).toBeDefined();
      expect(meta.name).toBe(contract!.name);
    }
  });

  it("no two tool files declare the same metadata.name", () => {
    const nameSet = new Set<string>();
    for (const meta of allToolMetadata) {
      expect(
        nameSet.has(meta.name),
        `Duplicate tool metadata name: "${meta.name}"`,
      ).toBe(false);
      nameSet.add(meta.name);
    }
  });

  it("has at least one registered tool (sanity: registry is non-empty)", () => {
    expect(allToolMetadata.length).toBeGreaterThan(0);
  });
});

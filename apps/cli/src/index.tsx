#!/usr/bin/env node
import { Command } from "commander";
import { render } from "ink";
import React from "react";
import { DevStatus } from "./components/DevStatus.js";
import { authLoginCommand } from "./commands/auth.login.js";
import { authLogoutCommand } from "./commands/auth.logout.js";
import { authWhoamiCommand } from "./commands/auth.whoami.js";
import { orgListCommand } from "./commands/org.list.js";
import { orgCreateCommand } from "./commands/org.create.js";
import { orgMemberAddCommand } from "./commands/org.member.add.js";
import { orgMemberRemoveCommand } from "./commands/org.member.remove.js";
import { workspaceListCommand } from "./commands/workspace.list.js";
import { workspaceCreateCommand } from "./commands/workspace.create.js";
import { chatSendCommand } from "./commands/chat.send.js";
import { conversationListCommand } from "./commands/conversation.list.js";
import { conversationDeleteCommand } from "./commands/conversation.delete.js";
import { conversationArchiveCommand } from "./commands/conversation.archive.js";
import { conversationRenameCommand } from "./commands/conversation.rename.js";
import { apiKeyCreateCommand } from "./commands/api-key.create.js";
import { apiKeyRevokeCommand } from "./commands/api-key.revoke.js";
import { notificationsListCommand } from "./commands/notifications.list.js";
import { notificationsMarkCommand } from "./commands/notifications.mark.js";
import { pluginListCommand } from "./commands/plugin.list.js";
import { pluginInstallCommand } from "./commands/plugin.install.js";
import { pluginUninstallCommand } from "./commands/plugin.uninstall.js";
import { pluginOrgInstallCommand } from "./commands/plugin.org.install.js";
import { pluginOrgUninstallCommand } from "./commands/plugin.org.uninstall.js";
import { pluginCatalogGetCommand } from "./commands/plugin.catalog.get.js";
import { billingStatusCommand } from "./commands/billing.status.js";
import { billingCreditsPurchaseCommand } from "./commands/billing.credits.purchase.js";
import { billingSubscriptionReadCommand } from "./commands/billing.subscription.read.js";
import { agentMcpListCommand } from "./commands/agent.mcp.list.js";
import { agentSkillListCommand } from "./commands/agent.skill.list.js";
import { agentToolListCommand } from "./commands/agent.tool.list.js";
import { agentApprovalResolveCommand } from "./commands/agent.approval.resolve.js";
import { orgMemberRoleChangeCommand } from "./commands/org.member.role.change.js";
import { archiveCreateCommand } from "./commands/archive.create.js";
import { workflowRunCommand } from "./commands/workflow.run.js";
import { userPreferencesGetCommand } from "./commands/user.preferences.get.js";
import { userPreferencesUpdateCommand } from "./commands/user.preferences.update.js";
import { workspaceMemberListCommand } from "./commands/workspace.member.list.js";
import { workspaceInviteSendCommand } from "./commands/workspace.invite.send.js";
import { conversationChatCommand } from "./commands/conversation.chat.js";
import { imageCreateCommand } from "./commands/image.create.js";
import { documentCreateCommand } from "./commands/document.create.js";
import { automationListCommand } from "./commands/automation.list.js";
import { imageListCommand } from "./commands/image.list.js";
import { imageAnalyzeCommand } from "./commands/image.analyze.js";
import { documentListCommand } from "./commands/document.list.js";
import { documentReadCommand } from "./commands/document.read.js";
import { formCreateCommand } from "./commands/form.create.js";
import { formSubmitCommand } from "./commands/form.submit.js";
import { automationCreateCommand } from "./commands/automation.create.js";
import { automationTriggerCommand } from "./commands/automation.trigger.js";
import { skillWorkspaceListCommand } from "./commands/skill.workspace.list.js";

const program = new Command();

program
  .name("oxagen")
  .description("Oxagen developer CLI")
  .version("0.2.0");

program
  .command("dev")
  .description("Show the current dev stack status")
  .action(() => {
    render(<DevStatus />);
  });

// auth
const auth = program.command("auth").description("Authentication commands");
auth.addCommand(authLoginCommand);
auth.addCommand(authLogoutCommand);
auth.addCommand(authWhoamiCommand);

// org
const org = program.command("org").description("Organization commands");
org.addCommand(orgListCommand);
org.addCommand(orgCreateCommand);

const orgMember = org.command("member").description("Org member management");
orgMember.addCommand(orgMemberAddCommand);
orgMember.addCommand(orgMemberRemoveCommand);
orgMember.addCommand(orgMemberRoleChangeCommand);

// workspace
const workspace = program.command("workspace").description("Workspace commands");
workspace.addCommand(workspaceListCommand);
workspace.addCommand(workspaceCreateCommand);

// chat
const chat = program.command("chat").description("Chat and messaging commands");
chat.addCommand(chatSendCommand);

// conversation
const conversation = program.command("conversation").description("Conversation management");
conversation.addCommand(conversationListCommand);
conversation.addCommand(conversationDeleteCommand);
conversation.addCommand(conversationArchiveCommand);
conversation.addCommand(conversationRenameCommand);

// api-key
const apiKey = program.command("api-key").description("API key management");
apiKey.addCommand(apiKeyCreateCommand);
apiKey.addCommand(apiKeyRevokeCommand);

// notifications
const notifications = program.command("notifications").description("Notification management");
notifications.addCommand(notificationsListCommand);
notifications.addCommand(notificationsMarkCommand);

// plugin
const plugin = program.command("plugin").description("Plugin marketplace commands");
plugin.addCommand(pluginListCommand);
plugin.addCommand(pluginInstallCommand);
plugin.addCommand(pluginUninstallCommand);
const pluginOrg = plugin.command("org").description("Plugin organization management");
pluginOrg.addCommand(pluginOrgInstallCommand);
pluginOrg.addCommand(pluginOrgUninstallCommand);
const pluginCatalog = plugin.command("catalog").description("Plugin catalog");
pluginCatalog.addCommand(pluginCatalogGetCommand);

// billing
const billing = program.command("billing").description("Billing and subscription commands");
billing.addCommand(billingStatusCommand);
billing.addCommand(billingCreditsPurchaseCommand);
billing.addCommand(billingSubscriptionReadCommand);

// agent
const agent = program.command("agent").description("Agent commands");
const agentMcp = agent.command("mcp").description("MCP server management");
agentMcp.addCommand(agentMcpListCommand);
const agentSkill = agent.command("skill").description("Agent skill management");
agentSkill.addCommand(agentSkillListCommand);
const agentTool = agent.command("tool").description("Agent tool management");
agentTool.addCommand(agentToolListCommand);
const agentApproval = agent.command("approval").description("Agent approval management");
agentApproval.addCommand(agentApprovalResolveCommand);

// archive
const archive = program.command("archive").description("Archive management");
archive.addCommand(archiveCreateCommand);

// workflow
const workflow = program.command("workflow").description("Workflow automation");
workflow.addCommand(workflowRunCommand);

// user
const user = program.command("user").description("User account commands");
const userPreferences = user.command("preferences").description("User preference management");
userPreferences.addCommand(userPreferencesGetCommand);
userPreferences.addCommand(userPreferencesUpdateCommand);

// workspace member + invite
const workspaceMember = workspace.command("member").description("Workspace member management");
workspaceMember.addCommand(workspaceMemberListCommand);
const workspaceInvite = workspace.command("invite").description("Workspace invitation management");
workspaceInvite.addCommand(workspaceInviteSendCommand);

// conversation chat
conversation.addCommand(conversationChatCommand);

// image
const image = program.command("image").description("Image generation commands");
image.addCommand(imageCreateCommand);
image.addCommand(imageListCommand);
image.addCommand(imageAnalyzeCommand);

// document
const document = program.command("document").description("Document management commands");
document.addCommand(documentCreateCommand);
document.addCommand(documentListCommand);
document.addCommand(documentReadCommand);

// automation
const automation = program.command("automation").description("Automation management commands");
automation.addCommand(automationListCommand);
automation.addCommand(automationCreateCommand);
automation.addCommand(automationTriggerCommand);

// form
const form = program.command("form").description("Form management commands");
form.addCommand(formCreateCommand);
form.addCommand(formSubmitCommand);

// skill
const skill = program.command("skill").description("Skill management commands");
const skillWorkspace = skill.command("workspace").description("Workspace skill management");
skillWorkspace.addCommand(skillWorkspaceListCommand);

program.parse(process.argv);

if (program.args.length === 0) {
  program.outputHelp();
}

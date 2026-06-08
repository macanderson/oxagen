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

program.parse(process.argv);

if (program.args.length === 0) {
  program.outputHelp();
}

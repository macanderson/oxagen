#!/usr/bin/env node
import { Command } from "commander";
// JSON modules expose only a default export under Node's ESM loader; a named
// `{ version }` import compiles under tsx but crashes the built binary at runtime.
import pkg from "../package.json" with { type: "json" };

const { version } = pkg;
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
import { automationEnableCommand } from "./commands/automation.enable.js";
import { automationDisableCommand } from "./commands/automation.disable.js";
import { imageListCommand } from "./commands/image.list.js";
import { imageAnalyzeCommand } from "./commands/image.analyze.js";
import { documentListCommand } from "./commands/document.list.js";
import { documentReadCommand } from "./commands/document.read.js";
import { formCreateCommand } from "./commands/form.create.js";
import { formSubmitCommand } from "./commands/form.submit.js";
import { automationCreateCommand } from "./commands/automation.create.js";
import { automationUpdateCommand } from "./commands/automation.update.js";
import { automationTriggerCommand } from "./commands/automation.trigger.js";
import { skillWorkspaceListCommand } from "./commands/skill.workspace.list.js";
import { skillWorkspaceInstallCommand } from "./commands/skill.workspace.install.js";
import { skillVersionListCommand } from "./commands/skill.version.list.js";
import { skillVersionGetCommand } from "./commands/skill.version.get.js";
import { skillVersionUploadCommand } from "./commands/skill.version.upload.js";
import { skillVersionActivateCommand } from "./commands/skill.version.activate.js";
import { skillEditCommand } from "./commands/skill.edit.js";
import { skillExportCommand } from "./commands/skill.export.js";
import { skillMetricsReadCommand } from "./commands/skill.metrics.read.js";
import { agentMemoryRecallCommand } from "./commands/agent.memory.recall.js";
import { agentMemoryWriteCommand } from "./commands/agent.memory.write.js";
import { videoGenerateCommand } from "./commands/video.generate.js";
import { svgGenerateCommand } from "./commands/svg.generate.js";
import { workspaceModelSettingsReadCommand } from "./commands/workspace.model.settings.read.js";
import { workspaceModelSettingsWriteCommand } from "./commands/workspace.model.settings.write.js";
import { orgMemberInviteAcceptCommand } from "./commands/org.member.invite.accept.js";
import { pluginRegistryListCommand } from "./commands/plugin.registry.list.js";
import { pluginCatalogBrowseCommand } from "./commands/plugin.catalog.browse.js";
import { pluginCredentialReauthCommand } from "./commands/plugin.credential.reauth.js";
import { imageGenerateCommand } from "./commands/image.generate.js";
import { documentsGenerateCommand } from "./commands/documents.generate.js";
import { pluginRegistryAddCommand } from "./commands/plugin.registry.add.js";
import { agentMcpRegisterCommand } from "./commands/agent.mcp.register.js";
import { agentMcpSetEnabledCommand } from "./commands/agent.mcp.set_enabled.js";
import { agentMcpDeleteCommand } from "./commands/agent.mcp.delete.js";
import { agentMcpConsentResolveCommand } from "./commands/agent.mcp.consent.resolve.js";
import { agentMcpConsentListCommand } from "./commands/agent.mcp.consent.list.js";
import { agentPlanApproveCommand } from "./commands/agent.plan.approve.js";
import { agentPlanCreateCommand } from "./commands/agent.plan.create.js";
import { agentTaskBackgroundReadCommand } from "./commands/agent.task.background.read.js";
import { agentTaskBackgroundStartCommand } from "./commands/agent.task.background.start.js";
import { agentTaskBackgroundCancelCommand } from "./commands/agent.task.background.cancel.js";
import { assetUploadCommand } from "./commands/asset.upload.js";
import { billingSubscriptionUpgradeStartCommand } from "./commands/billing.subscription.upgrade.start.js";
import { brandkitApplyCommand } from "./commands/brandkit.apply.js";
import { conversationPurgeCommand } from "./commands/conversation.purge.js";
import { conversationFilesListCommand } from "./commands/conversation.files.list.js";
import { documentsPdfCreateCommand } from "./commands/documents.pdf.create.js";
import { markdownGenerateCommand } from "./commands/markdown.generate.js";
import { mermaidGenerateCommand } from "./commands/mermaid.generate.js";
import { formFillCommand } from "./commands/form.fill.js";
import { orgMemberInviteDeclineCommand } from "./commands/org.member.invite.decline.js";
import { organizationCreateCommand } from "./commands/organization.create.js";
import { pluginCredentialSetSecretCommand } from "./commands/plugin.credential.set_secret.js";
import { pluginOrgInstallBulkCommand } from "./commands/plugin.org.install_bulk.js";
import { pluginOrgListCommand } from "./commands/plugin.org.list.js";
import { pluginOrgSetEnabledCommand } from "./commands/plugin.org.set_enabled.js";
import { pluginRegistryRemoveCommand } from "./commands/plugin.registry.remove.js";
import { pluginSettingsSetAuthAlertsCommand } from "./commands/plugin.settings.set_auth_alerts.js";
import { pluginWorkspaceSetEnabledCommand } from "./commands/plugin.workspace.set_enabled.js";
import { systemInstallInstructionsCommand } from "./commands/system.install.instructions.js";
import { workflowCancelCommand } from "./commands/workflow.cancel.js";
import { workflowStatusCommand } from "./commands/workflow.status.js";
import { userPreferencesReadCommand } from "./commands/user.preferences.read.js";
import { userPreferencesWriteCommand } from "./commands/user.preferences.write.js";
import { privacyExportCommand } from "./commands/privacy.export.js";
import { privacyEraseCommand } from "./commands/privacy.erase.js";
import { graphNodeUpsertCommand } from "./commands/graph.node.upsert.js";
import { graphNodeGetCommand } from "./commands/graph.node.get.js";
import { graphNodeDeleteCommand } from "./commands/graph.node.delete.js";
import { graphNodeSearchCommand } from "./commands/graph.node.search.js";
import { graphEdgeUpsertCommand } from "./commands/graph.edge.upsert.js";
import { graphEdgeDeleteCommand } from "./commands/graph.edge.delete.js";
import { graphCypherCommand } from "./commands/graph.cypher.js";
import { ontologyQueryCommand } from "./commands/ontology.query.js";
import { ontologyNeighborsCommand } from "./commands/ontology.neighbors.js";
import { auditLogQueryCommand } from "./commands/audit.log.query.js";
import { webSearchCommand } from "./commands/web.search.js";
import { webFetchCommand } from "./commands/web.fetch.js";
import { researchSwarmStartCommand } from "./commands/research.swarm.start.js";
import { researchSwarmStatusCommand } from "./commands/research.swarm.status.js";
import { schemaReconcileCommand } from "./commands/schema/schema.reconcile.js";
import { schemaListCommand } from "./commands/schema/schema.list.js";
import { schemaGetCommand } from "./commands/schema/schema.get.js";
import { schemaConfigCommand } from "./commands/schema/schema.config.js";
import { schemaEnableCommand } from "./commands/schema/schema.enable.js";
import { schemaDisableCommand } from "./commands/schema/schema.disable.js";
import { schemaExportCommand } from "./commands/schema/schema.export.js";
import { schemaLabelCommand } from "./commands/schema/schema.label.js";
import { schemaRelCommand } from "./commands/schema/schema.rel.js";
import { schemaPropCommand } from "./commands/schema/schema.prop.js";
import { schemaVersionCommand } from "./commands/schema/schema.version.js";

const program = new Command();

program
  .name("oxagen")
  .description("Oxagen developer CLI")
  .version(version);

program
  .command("dev")
  .description("Show the current dev stack status")
  .action(async () => {
    // Lazy-load the Ink/React TUI so the React reconciler is only initialised
    // for this one command — the other ~134 commands start without paying for it.
    const [{ render }, { DevStatus }] = await Promise.all([
      import("ink"),
      import("./components/DevStatus.js"),
    ]);
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
const orgMemberInvite = orgMember.command("invite").description("Org member invitations");
orgMemberInvite.addCommand(orgMemberInviteAcceptCommand);
orgMemberInvite.addCommand(orgMemberInviteDeclineCommand);
org.addCommand(organizationCreateCommand);

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
pluginCatalog.addCommand(pluginCatalogBrowseCommand);
const pluginRegistry = plugin.command("registry").description("Plugin registry management");
pluginRegistry.addCommand(pluginRegistryListCommand);
pluginRegistry.addCommand(pluginRegistryAddCommand);
pluginRegistry.addCommand(pluginRegistryRemoveCommand);
const pluginCredential = plugin.command("credential").description("Plugin credential management");
pluginCredential.addCommand(pluginCredentialReauthCommand);
pluginCredential.addCommand(pluginCredentialSetSecretCommand);
pluginOrg.addCommand(pluginOrgInstallBulkCommand);
pluginOrg.addCommand(pluginOrgListCommand);
pluginOrg.addCommand(pluginOrgSetEnabledCommand);
const pluginSettings = plugin.command("settings").description("Plugin settings");
pluginSettings.addCommand(pluginSettingsSetAuthAlertsCommand);
pluginOrg.addCommand(pluginWorkspaceSetEnabledCommand);

// billing
const billing = program.command("billing").description("Billing and subscription commands");
billing.addCommand(billingStatusCommand);
billing.addCommand(billingCreditsPurchaseCommand);
billing.addCommand(billingSubscriptionReadCommand);
const billingSubscription = billing.command("subscription").description("Subscription management");
billingSubscription.addCommand(billingSubscriptionUpgradeStartCommand);

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
const agentMemory = agent.command("memory").description("Agent memory management");
agentMemory.addCommand(agentMemoryRecallCommand);
agentMemory.addCommand(agentMemoryWriteCommand);
agentMcp.addCommand(agentMcpRegisterCommand);
agentMcp.addCommand(agentMcpSetEnabledCommand);
agentMcp.addCommand(agentMcpDeleteCommand);
const agentMcpConsent = agentMcp.command("consent").description("External MCP tool consent grants");
agentMcpConsent.addCommand(agentMcpConsentResolveCommand);
agentMcpConsent.addCommand(agentMcpConsentListCommand);
const agentPlan = agent.command("plan").description("Agent plan management");
agentPlan.addCommand(agentPlanApproveCommand);
agentPlan.addCommand(agentPlanCreateCommand);
const agentTask = agent.command("task").description("Agent task management");
const agentTaskBackground = agentTask.command("background").description("Background task management");
agentTaskBackground.addCommand(agentTaskBackgroundReadCommand);
agentTaskBackground.addCommand(agentTaskBackgroundStartCommand);
agentTaskBackground.addCommand(agentTaskBackgroundCancelCommand);

// archive
const archive = program.command("archive").description("Archive management");
archive.addCommand(archiveCreateCommand);

// asset
const asset = program.command("asset").description("Asset management");
asset.addCommand(assetUploadCommand);

// brandkit
const brandkit = program.command("brandkit").description("Brand kit commands");
brandkit.addCommand(brandkitApplyCommand);

// workflow
const workflow = program.command("workflow").description("Workflow automation");
workflow.addCommand(workflowRunCommand);
workflow.addCommand(workflowCancelCommand);
workflow.addCommand(workflowStatusCommand);

// system
const system = program.command("system").description("System commands");
system.addCommand(systemInstallInstructionsCommand);

// user
const user = program.command("user").description("User account commands");
const userPreferences = user.command("preferences").description("User preference management");
userPreferences.addCommand(userPreferencesGetCommand);
userPreferences.addCommand(userPreferencesUpdateCommand);
userPreferences.addCommand(userPreferencesReadCommand);
userPreferences.addCommand(userPreferencesWriteCommand);

// workspace member + invite
const workspaceMember = workspace.command("member").description("Workspace member management");
workspaceMember.addCommand(workspaceMemberListCommand);
const workspaceInvite = workspace.command("invite").description("Workspace invitation management");
workspaceInvite.addCommand(workspaceInviteSendCommand);
const workspaceModel = workspace.command("model").description("Workspace model settings");
const workspaceModelSettings = workspaceModel.command("settings").description("Model settings management");
workspaceModelSettings.addCommand(workspaceModelSettingsReadCommand);
workspaceModelSettings.addCommand(workspaceModelSettingsWriteCommand);

// conversation chat + purge
conversation.addCommand(conversationChatCommand);
conversation.addCommand(conversationPurgeCommand);
conversation.addCommand(conversationFilesListCommand);

// image
const image = program.command("image").description("Image generation commands");
image.addCommand(imageCreateCommand);
image.addCommand(imageListCommand);
image.addCommand(imageAnalyzeCommand);
image.addCommand(imageGenerateCommand);

// document
const document = program.command("document").description("Document management commands");
document.addCommand(documentCreateCommand);
document.addCommand(documentListCommand);
document.addCommand(documentReadCommand);
const documents = program.command("documents").description("Document generation commands");
documents.addCommand(documentsGenerateCommand);
documents.addCommand(documentsPdfCreateCommand);
documents.addCommand(markdownGenerateCommand);

// mermaid (diagram generation — top-level group like svg/video)
const mermaid = program.command("mermaid").description("Mermaid diagram generation commands");
mermaid.addCommand(mermaidGenerateCommand);

// automation
const automation = program.command("automation").description("Automation management commands");
automation.addCommand(automationListCommand);
automation.addCommand(automationCreateCommand);
automation.addCommand(automationUpdateCommand);
automation.addCommand(automationEnableCommand);
automation.addCommand(automationDisableCommand);
automation.addCommand(automationTriggerCommand);

// form
const form = program.command("form").description("Form management commands");
form.addCommand(formCreateCommand);
form.addCommand(formSubmitCommand);
form.addCommand(formFillCommand);

// skill
const skill = program.command("skill").description("Skill management commands");
const skillWorkspace = skill.command("workspace").description("Workspace skill management");
skillWorkspace.addCommand(skillWorkspaceListCommand);
skillWorkspace.addCommand(skillWorkspaceInstallCommand);
const skillVersion = skill.command("version").description("Skill version management");
skillVersion.addCommand(skillVersionListCommand);
skillVersion.addCommand(skillVersionGetCommand);
skillVersion.addCommand(skillVersionUploadCommand);
skillVersion.addCommand(skillVersionActivateCommand);
skill.addCommand(skillEditCommand);
skill.addCommand(skillExportCommand);
skill.addCommand(skillMetricsReadCommand);

// video
const video = program.command("video").description("Video generation commands");
video.addCommand(videoGenerateCommand);

// svg
const svg = program.command("svg").description("SVG generation commands");
svg.addCommand(svgGenerateCommand);

// privacy (GDPR Art.17 erasure + Art.20 portability)
const privacy = program.command("privacy").description("GDPR privacy rights — data export and erasure");
privacy.addCommand(privacyExportCommand);
privacy.addCommand(privacyEraseCommand);

// graph
const graph = program.command("graph").description("Knowledge graph commands");
const graphNode = graph.command("node").description("Graph node management");
graphNode.addCommand(graphNodeUpsertCommand);
graphNode.addCommand(graphNodeGetCommand);
graphNode.addCommand(graphNodeDeleteCommand);
graphNode.addCommand(graphNodeSearchCommand);
const graphEdge = graph.command("edge").description("Graph edge management");
graphEdge.addCommand(graphEdgeUpsertCommand);
graphEdge.addCommand(graphEdgeDeleteCommand);
graph.addCommand(graphCypherCommand);

// ontology
const ontology = program
  .command("ontology")
  .description("Typed knowledge-graph traversal commands");
ontology.addCommand(ontologyQueryCommand);
ontology.addCommand(ontologyNeighborsCommand);

// audit
const audit = program.command("audit").description("Audit-log commands");
const auditLog = audit.command("log").description("Query the security & automation audit spines");
auditLog.addCommand(auditLogQueryCommand);

// web
const web = program.command("web").description("Web intelligence commands");
web.addCommand(webSearchCommand);
web.addCommand(webFetchCommand);

// research
const research = program.command("research").description("Research swarm commands");
const researchSwarm = research.command("swarm").description("Research swarm management");
researchSwarm.addCommand(researchSwarmStartCommand);
researchSwarm.addCommand(researchSwarmStatusCommand);

// schema
const schemaCmd = program.command("schema").description("Schema registry commands");
schemaCmd.addCommand(schemaListCommand);
schemaCmd.addCommand(schemaGetCommand);
schemaCmd.addCommand(schemaConfigCommand);
schemaCmd.addCommand(schemaEnableCommand);
schemaCmd.addCommand(schemaDisableCommand);
schemaCmd.addCommand(schemaExportCommand);
schemaCmd.addCommand(schemaLabelCommand);
schemaCmd.addCommand(schemaRelCommand);
schemaCmd.addCommand(schemaPropCommand);
schemaCmd.addCommand(schemaVersionCommand);
schemaCmd.addCommand(schemaReconcileCommand);

async function main(): Promise<void> {
  const noCommand = process.argv.slice(2).length === 0;
  const wantsTui =
    noCommand && Boolean(process.stdout.isTTY) && !process.env.OXAGEN_NO_TUI;

  if (wantsTui) {
    // Lazy-load Ink so the ~134 non-interactive commands never pay for it.
    const { launchTui } = await import("./tui/app.js");
    await launchTui(program, version);
  } else {
    await program.parseAsync(process.argv);
  }
}

void main();

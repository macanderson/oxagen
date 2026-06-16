import { registerHandler, registerHandlersOnce, type CapabilityHandlerFn } from "@oxagen/oxagen/kernel";

// Side-effect module: binds every foundation handler to its capability in the
// kernel as a lazy loader. Import once at app boot (api, mcp, cli) before
// dispatching. Loaders are dynamic so booting a surface does not eagerly pull
// in Stripe / Drizzle until a capability is actually invoked.
//
// Wrapped in `registerHandlersOnce` so a dev bundler re-evaluating this module
// on hot reload is a no-op instead of tripping the kernel's duplicate guard.
registerHandlersOnce("@oxagen/handlers", () => {
  registerHandler(
    "api.key.create",
    async () => (await import("./api.key.create")).apiKeyCreateHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "api.key.revoke",
    async () => (await import("./api.key.revoke")).apiKeyRevokeHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "asset.upload",
    async () => (await import("./asset.upload")).assetUploadHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "organization.create",
    async () => (await import("./organization.create")).organizationCreateHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "workspace.create",
    async () => (await import("./workspace.create")).workspaceCreateHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "billing.subscription.read",
    async () => (await import("./billing.subscription.read")).billingSubscriptionReadHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "billing.subscription.upgrade.start",
    async () =>
      (await import("./billing.subscription.upgrade.start"))
        .billingSubscriptionUpgradeStartHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "billing.credits.purchase",
    async () => (await import("./billing.credits.purchase")).billingCreditsPurchaseHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "chat.message.send",
    async () => (await import("./chat.message.send")).chatMessageSendHandler as CapabilityHandlerFn,
  );
  registerHandler("form.fill", async () => (await import("./form.fill")).formFillHandler as CapabilityHandlerFn);
  registerHandler(
    "archive.create",
    async () => (await import("./archive.create")).archiveCreateHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "documents.generate",
    async () => (await import("./documents.generate")).documentsGenerateHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "documents.pdf.create",
    async () => (await import("./documents.pdf.create")).documentsPdfCreateHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "brandkit.apply",
    async () => (await import("./brandkit.apply")).brandkitApplyHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "video.generate",
    async () => (await import("./video.generate")).videoGenerateHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "svg.generate",
    async () => (await import("./svg.generate")).svgGenerateHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "image.generate",
    async () => (await import("./image.generate")).imageGenerateHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "system.install.instructions",
    async () => (await import("./system.install.instructions")).systemInstallInstructionsHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "org.member.add",
    async () => (await import("./org.member.add")).orgMemberAddHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "org.member.invite.accept",
    async () => (await import("./org.member.invite.accept")).orgMemberInviteAcceptHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "org.member.invite.decline",
    async () => (await import("./org.member.invite.decline")).orgMemberInviteDeclineHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "org.member.remove",
    async () => (await import("./org.member.remove")).orgMemberRemoveHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "org.member.role.change",
    async () => (await import("./org.member.role.change")).orgMemberRoleChangeHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "user.preferences.read",
    async () => (await import("./user.preferences.read")).userPreferencesReadHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "user.preferences.write",
    async () => (await import("./user.preferences.write")).userPreferencesWriteHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "workspace.model.settings.read",
    async () =>
      (await import("./workspace.model.settings.read")).workspaceModelSettingsReadHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "workspace.model.settings.write",
    async () =>
      (await import("./workspace.model.settings.write")).workspaceModelSettingsWriteHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "prompt.settings.read",
    async () => (await import("./prompt.settings.read")).promptSettingsReadHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "prompt.settings.write",
    async () => (await import("./prompt.settings.write")).promptSettingsWriteHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "conversation.list",
    async () => (await import("./conversation.list")).conversationListHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "conversation.rename",
    async () => (await import("./conversation.rename")).conversationRenameHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "conversation.archive",
    async () => (await import("./conversation.archive")).conversationArchiveHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "conversation.delete",
    async () => (await import("./conversation.delete")).conversationDeleteHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "conversation.purge",
    async () => (await import("./conversation.purge")).conversationPurgeHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "plugin.registry.list",
    async () => (await import("./plugin.registry.list")).handler as CapabilityHandlerFn,
  );
  registerHandler(
    "plugin.registry.add",
    async () => (await import("./plugin.registry.add")).handler as CapabilityHandlerFn,
  );
  registerHandler(
    "plugin.registry.remove",
    async () => (await import("./plugin.registry.remove")).handler as CapabilityHandlerFn,
  );
  registerHandler(
    "plugin.registry.sync",
    async () => (await import("./plugin.registry.sync")).handler as CapabilityHandlerFn,
  );
  registerHandler(
    "plugin.catalog.browse",
    async () => (await import("./plugin.catalog.browse")).handler as CapabilityHandlerFn,
  );
  registerHandler("plugin.org.list", async () => (await import("./plugin.org.list")).handler as CapabilityHandlerFn);
  registerHandler(
    "plugin.catalog.get",
    async () => (await import("./plugin.catalog.get")).handler as CapabilityHandlerFn,
  );
  registerHandler(
    "plugin.org.install",
    async () => (await import("./plugin.org.install")).handler as CapabilityHandlerFn,
  );
  registerHandler(
    "plugin.org.install_bulk",
    async () => (await import("./plugin.org.install_bulk")).handler as CapabilityHandlerFn,
  );
  registerHandler(
    "plugin.org.uninstall",
    async () => (await import("./plugin.org.uninstall")).handler as CapabilityHandlerFn,
  );
  registerHandler(
    "plugin.org.set_enabled",
    async () => (await import("./plugin.org.set_enabled")).handler as CapabilityHandlerFn,
  );
  registerHandler(
    "plugin.denylist.add",
    async () => (await import("./plugin.denylist.add")).handler as CapabilityHandlerFn,
  );
  registerHandler(
    "plugin.denylist.remove",
    async () => (await import("./plugin.denylist.remove")).handler as CapabilityHandlerFn,
  );
  registerHandler(
    "plugin.workspace.set_enabled",
    async () => (await import("./plugin.workspace.set_enabled")).handler as CapabilityHandlerFn,
  );
  registerHandler(
    "plugin.credential.set_secret",
    async () => (await import("./plugin.credential.set_secret")).handler as CapabilityHandlerFn,
  );
  registerHandler(
    "plugin.credential.reauth",
    async () => (await import("./plugin.credential.reauth")).handler as CapabilityHandlerFn,
  );
  registerHandler(
    "notifications.list",
    async () => (await import("./notifications.list")).handler as CapabilityHandlerFn,
  );
  registerHandler(
    "notifications.mark",
    async () => (await import("./notifications.mark")).handler as CapabilityHandlerFn,
  );
  registerHandler(
    "plugin.settings.set_auth_alerts",
    async () => (await import("./plugin.settings.set_auth_alerts")).handler as CapabilityHandlerFn,
  );
  registerHandler(
    "workflow.run",
    async () => (await import("./workflow.run")).workflowRunHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "workflow.status",
    async () => (await import("./workflow.status")).workflowStatusHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "workflow.cancel",
    async () => (await import("./workflow.cancel")).workflowCancelHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "workspace.member.list",
    async () =>
      (await import("./workspace.member.list")).workspaceMemberListHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "workspace.invite.send",
    async () =>
      (await import("./workspace.invite.send")).workspaceInviteSendHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "conversation.chat",
    async () =>
      (await import("./conversation.chat")).conversationChatHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "image.create",
    async () => (await import("./image.create")).imageCreateHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "image.list",
    async () => (await import("./image.list")).imageListHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "image.analyze",
    async () => (await import("./image.analyze")).imageAnalyzeHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "document.create",
    async () => (await import("./document.create")).documentCreateHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "document.list",
    async () => (await import("./document.list")).documentListHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "document.read",
    async () => (await import("./document.read")).documentReadHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "form.create",
    async () => (await import("./form.create")).formCreateHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "form.submit",
    async () => (await import("./form.submit")).formSubmitHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "automation.list",
    async () => (await import("./automation.list")).automationListHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "automation.create",
    async () =>
      (await import("./automation.create")).automationCreateHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "automation.enable",
    async () =>
      (await import("./automation.enable")).automationEnableHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "automation.disable",
    async () =>
      (await import("./automation.disable")).automationDisableHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "automation.trigger",
    async () =>
      (await import("./automation.trigger")).automationTriggerHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "skill.workspace.list",
    async () =>
      (await import("./skill.workspace.list")).skillWorkspaceListHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "agent.execution.record",
    async () =>
      (await import("./agent.execution.record")).agentExecutionRecordHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "chat.message.execution",
    async () =>
      (await import("./chat.message.execution")).chatMessageExecutionHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "connection.create",
    async () => (await import("./connection.create")).connectionCreateHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "connection.list",
    async () => (await import("./connection.list")).connectionListHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "connection.get",
    async () => (await import("./connection.get")).connectionGetHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "connection.delete",
    async () => (await import("./connection.delete")).connectionDeleteHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "connection.preview",
    async () => (await import("./connection.preview")).connectionPreviewHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "connection.mappings.get",
    async () =>
      (await import("./connection.mappings.get")).connectionMappingsGetHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "connection.mappings.set",
    async () =>
      (await import("./connection.mappings.set")).connectionMappingsSetHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "connection.mappings.suggest",
    async () =>
      (await import("./connection.mappings.suggest")).connectionMappingsSuggestHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "graph.node.upsert",
    async () => (await import("./graph.node.upsert")).graphNodeUpsertHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "graph.node.get",
    async () => (await import("./graph.node.get")).graphNodeGetHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "graph.node.delete",
    async () => (await import("./graph.node.delete")).graphNodeDeleteHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "graph.node.search",
    async () => (await import("./graph.node.search")).graphNodeSearchHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "graph.edge.upsert",
    async () => (await import("./graph.edge.upsert")).graphEdgeUpsertHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "graph.edge.delete",
    async () => (await import("./graph.edge.delete")).graphEdgeDeleteHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "graph.cypher",
    async () => (await import("./graph.cypher")).graphCypherHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "web.search",
    async () => (await import("./web.search")).webSearchHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "web.fetch",
    async () => (await import("./web.fetch")).webFetchHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "research.swarm.start",
    async () =>
      (await import("./research.swarm.start")).researchSwarmStartHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "research.swarm.status",
    async () =>
      (await import("./research.swarm.status")).researchSwarmStatusHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "repo.sync",
    async () => (await import("./repo.sync")).repoSyncHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "repo.configure",
    async () => (await import("./repo.configure")).repoConfigureHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "repo.pause",
    async () => (await import("./repo.pause")).repoPauseHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "repo.resume",
    async () => (await import("./repo.resume")).repoResumeHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "repo.metrics",
    async () => (await import("./repo.metrics")).repoMetricsHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "integration.install",
    async () => (await import("./integration.install")).integrationInstallHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "integration.configure",
    async () => (await import("./integration.configure")).integrationConfigureHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "integration.list",
    async () => (await import("./integration.list")).integrationListHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "integration.get",
    async () => (await import("./integration.get")).integrationGetHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "integration.sync",
    async () => (await import("./integration.sync")).integrationSyncHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "integration.metrics",
    async () => (await import("./integration.metrics")).integrationMetricsHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "integration.delete",
    async () => (await import("./integration.delete")).integrationDeleteHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "plugin.schema.get",
    async () => (await import("./plugin.schema.get")).pluginSchemaGetHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "plugin.schema.validate",
    async () => (await import("./plugin.schema.validate")).pluginSchemaValidateHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "plugin.version.list",
    async () => (await import("./plugin.version.list")).pluginVersionListHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "semantic.edge.approve",
    async () => (await import("./semantic.edge.approve")).semanticEdgeApproveHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "semantic.edge.infer",
    async () => (await import("./semantic.edge.infer")).semanticEdgeInferHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "semantic.edge.list",
    async () => (await import("./semantic.edge.list")).semanticEdgeListHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "semantic.edge.suggest",
    async () => (await import("./semantic.edge.suggest")).semanticEdgeSuggestHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "graph.node.list",
    async () => (await import("./graph.node.list")).graphNodeListHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "graph.stats",
    async () => (await import("./graph.stats")).graphStatsHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "ontology.query",
    async () => (await import("./ontology.query")).ontologyQueryHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "ontology.neighbors",
    async () =>
      (await import("./ontology.neighbors")).ontologyNeighborsHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "audit.log.query",
    async () => (await import("./audit.log.query")).auditLogQueryHandler as CapabilityHandlerFn,
  );
});

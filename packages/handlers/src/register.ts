import {
  registerHandler,
  registerHandlersOnce,
  type CapabilityHandlerFn,
} from "@oxagen/oxagen/kernel";

// Side-effect module: binds every foundation handler to its capability in the
// kernel as a lazy loader. Import once at app boot (api, mcp, cli) before
// dispatching. Loaders are dynamic so booting a surface does not eagerly pull
// in Stripe / Drizzle until a capability is actually invoked.
//
// Wrapped in `registerHandlersOnce` so a dev bundler re-evaluating this module
// on hot reload is a no-op instead of tripping the kernel's duplicate guard.
registerHandlersOnce("@oxagen/handlers", () => {
  registerHandler(
    "run_capability_chain",
    async () =>
      (await import("./agent.compose"))
        .agentComposeHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "suggest_agent_def",
    async () =>
      (await import("./agent.definition.suggest"))
        .agentDefinitionSuggestHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "revise_agent_def",
    async () =>
      (await import("./agent.definition.revise"))
        .agentDefinitionReviseHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "summarize_agent_def",
    async () =>
      (await import("./agent.definition.summarize"))
        .agentDefinitionSummarizeHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "get_memory_policy",
    async () =>
      (await import("./agent.memory_policy.read"))
        .agentMemoryPolicyReadHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "update_memory_policy",
    async () =>
      (await import("./agent.memory_policy.write"))
        .agentMemoryPolicyWriteHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "ingest_graph",
    async () =>
      (await import("./graph.ingest"))
        .graphIngestHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "get_subagent_logs",
    async () =>
      (await import("./agent.subagent.logs"))
        .agentSubagentLogsHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "create_api_key",
    async () =>
      (await import("./api.key.create"))
        .apiKeyCreateHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "revoke_api_key",
    async () =>
      (await import("./api.key.revoke"))
        .apiKeyRevokeHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "rotate_api_key",
    async () =>
      (await import("./api.key.rotate"))
        .apiKeyRotateHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "upload_asset",
    async () =>
      (await import("./asset.upload"))
        .assetUploadHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "create_org",
    async () =>
      (await import("./org.create"))
        .organizationCreateHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "create_workspace",
    async () =>
      (await import("./workspace.create"))
        .workspaceCreateHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "list_orgs",
    async () =>
      (await import("./org.list")).orgListHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "list_workspaces",
    async () =>
      (await import("./workspace.list"))
        .workspaceListHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "get_subscription",
    async () =>
      (await import("./billing.subscription.read"))
        .billingSubscriptionReadHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "get_usage_breakdown",
    async () =>
      (await import("./billing.usage.breakdown"))
        .billingUsageBreakdownHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "start_subscription_upgrade",
    async () =>
      (await import("./billing.subscription_upgrade.start"))
        .billingSubscriptionUpgradeStartHandler as CapabilityHandlerFn,
  );
  // ── Reseller revenue (Stripe-for-agents re-bill loop) ──────────────────────
  registerHandler(
    "create_reseller_customer",
    async () =>
      (await import("./billing.reseller_customer.create"))
        .resellerCustomerCreateHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "list_reseller_customers",
    async () =>
      (await import("./billing.reseller_customer.list"))
        .resellerCustomerListHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "update_reseller_customer",
    async () =>
      (await import("./billing.reseller_customer.update"))
        .resellerCustomerUpdateHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "archive_reseller_customer",
    async () =>
      (await import("./billing.reseller_customer.archive"))
        .resellerCustomerArchiveHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "create_reseller_price_plan",
    async () =>
      (await import("./billing.reseller_price_plan.create"))
        .resellerPricePlanCreateHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "list_reseller_price_plans",
    async () =>
      (await import("./billing.reseller_price_plan.list"))
        .resellerPricePlanListHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "update_reseller_price_plan",
    async () =>
      (await import("./billing.reseller_price_plan.update"))
        .resellerPricePlanUpdateHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "save_reseller_attribution_rule",
    async () =>
      (await import("./billing.reseller_attribution_rule.save"))
        .resellerAttributionRuleSaveHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "list_reseller_attribution_rules",
    async () =>
      (await import("./billing.reseller_attribution_rule.list"))
        .resellerAttributionRuleListHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "delete_reseller_attribution_rule",
    async () =>
      (await import("./billing.reseller_attribution_rule.delete"))
        .resellerAttributionRuleDeleteHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "preview_reseller_rebill",
    async () =>
      (await import("./billing.reseller_rebill.preview"))
        .resellerRebillPreviewHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "push_reseller_rebill",
    async () =>
      (await import("./billing.reseller_rebill.push"))
        .resellerRebillPushHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "list_reseller_rebill_runs",
    async () =>
      (await import("./billing.reseller_rebill.list_runs"))
        .resellerRebillListRunsHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "configure_reseller_stripe",
    async () =>
      (await import("./billing.reseller_stripe.configure"))
        .resellerStripeConfigureHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "get_reseller_stripe_status",
    async () =>
      (await import("./billing.reseller_stripe.status"))
        .resellerStripeStatusHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "purchase_credits",
    async () =>
      (await import("./billing.credits.purchase"))
        .billingCreditsPurchaseHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "send_message",
    async () =>
      (await import("./chat.message.send"))
        .chatMessageSendHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "fill_form",
    async () =>
      (await import("./form.fill")).formFillHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "create_archive",
    async () =>
      (await import("./archive.create"))
        .archiveCreateHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "generate_document",
    async () =>
      (await import("./document.generate"))
        .documentsGenerateHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "create_pdf",
    async () =>
      (await import("./document.pdf.create"))
        .documentsPdfCreateHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "generate_markdown",
    async () =>
      (await import("./markdown.generate"))
        .markdownGenerateHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "generate_mermaid",
    async () =>
      (await import("./mermaid.generate"))
        .mermaidGenerateHandler as CapabilityHandlerFn,
  );

  registerHandler(
    "generate_video",
    async () =>
      (await import("./video.generate"))
        .videoGenerateHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "generate_svg",
    async () =>
      (await import("./svg.generate"))
        .svgGenerateHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "generate_image",
    async () =>
      (await import("./image.generate"))
        .imageGenerateHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "get_install_instructions",
    async () =>
      (await import("./system.install.instructions"))
        .systemInstallInstructionsHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "add_org_member",
    async () =>
      (await import("./org.member.add"))
        .orgMemberAddHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "accept_member_invite",
    async () =>
      (await import("./org.member_invite.accept"))
        .orgMemberInviteAcceptHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "decline_member_invite",
    async () =>
      (await import("./org.member_invite.decline"))
        .orgMemberInviteDeclineHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "remove_org_member",
    async () =>
      (await import("./org.member.remove"))
        .orgMemberRemoveHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "change_member_role",
    async () =>
      (await import("./org.member_role.change"))
        .orgMemberRoleChangeHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "get_user_preferences",
    async () =>
      (await import("./user.preferences.read"))
        .userPreferencesReadHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "update_user_preferences",
    async () =>
      (await import("./user.preferences.write"))
        .userPreferencesWriteHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "get_workspace_user_preferences",
    async () =>
      (await import("./user.workspace_preferences.read"))
        .userWorkspacePreferencesReadHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "update_workspace_user_preferences",
    async () =>
      (await import("./user.workspace_preferences.write"))
        .userWorkspacePreferencesWriteHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "get_user_budget",
    async () =>
      (await import("./budget.policy.read"))
        .budgetPolicyReadHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "update_user_budget",
    async () =>
      (await import("./budget.policy.write"))
        .budgetPolicyWriteHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "get_model_settings",
    async () =>
      (await import("./workspace.model_settings.read"))
        .workspaceModelSettingsReadHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "update_model_settings",
    async () =>
      (await import("./workspace.model_settings.write"))
        .workspaceModelSettingsWriteHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "get_workspace_settings",
    async () =>
      (await import("./workspace.settings.read"))
        .workspaceSettingsReadHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "update_workspace_settings",
    async () =>
      (await import("./workspace.settings.write"))
        .workspaceSettingsWriteHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "get_org_settings",
    async () =>
      (await import("./org.settings.read"))
        .orgSettingsReadHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "update_org_settings",
    async () =>
      (await import("./org.settings.write"))
        .orgSettingsWriteHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "get_prompt_settings",
    async () =>
      (await import("./prompt.settings.read"))
        .promptSettingsReadHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "update_prompt_settings",
    async () =>
      (await import("./prompt.settings.write"))
        .promptSettingsWriteHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "list_conversations",
    async () =>
      (await import("./conversation.list"))
        .conversationListHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "rename_conversation",
    async () =>
      (await import("./conversation.rename"))
        .conversationRenameHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "archive_conversation",
    async () =>
      (await import("./conversation.archive"))
        .conversationArchiveHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "delete_conversation",
    async () =>
      (await import("./conversation.delete"))
        .conversationDeleteHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "purge_conversations",
    async () =>
      (await import("./conversation.purge"))
        .conversationPurgeHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "list_conversation_files",
    async () =>
      (await import("./conversation.files.list"))
        .conversationFilesListHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "export_conversation",
    async () =>
      (await import("./conversation.export"))
        .conversationExportHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "add_conversation_attachment",
    async () =>
      (await import("./conversation.attachment.add"))
        .conversationAttachmentAddHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "export_data",
    async () =>
      (await import("./privacy.data.export"))
        .privacyDataExportHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "erase_data",
    async () =>
      (await import("./privacy.data.erase"))
        .privacyDataEraseHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "list_plugin_registries",
    async () =>
      (await import("./plugin.registry.list")).handler as CapabilityHandlerFn,
  );
  registerHandler(
    "add_plugin_registry",
    async () =>
      (await import("./plugin.registry.add")).handler as CapabilityHandlerFn,
  );
  registerHandler(
    "remove_plugin_registry",
    async () =>
      (await import("./plugin.registry.remove")).handler as CapabilityHandlerFn,
  );
  registerHandler(
    "browse_plugin_catalog",
    async () =>
      (await import("./plugin.catalog.browse")).handler as CapabilityHandlerFn,
  );
  registerHandler(
    "sync_plugin_catalog",
    async () =>
      (await import("./plugin.catalog.sync.handler"))
        .handler as CapabilityHandlerFn,
  );
  registerHandler(
    "list_plugins",
    async () =>
      (await import("./plugin.org.list")).handler as CapabilityHandlerFn,
  );
  registerHandler(
    "get_catalog_plugin",
    async () =>
      (await import("./plugin.catalog.get")).handler as CapabilityHandlerFn,
  );
  registerHandler(
    "install_plugin",
    async () =>
      (await import("./plugin.org.install")).handler as CapabilityHandlerFn,
  );
  registerHandler(
    "install_plugins_bulk",
    async () =>
      (await import("./plugin.org.install_bulk"))
        .handler as CapabilityHandlerFn,
  );
  registerHandler(
    "uninstall_plugin",
    async () =>
      (await import("./plugin.org.uninstall")).handler as CapabilityHandlerFn,
  );
  registerHandler(
    "set_plugin_enabled",
    async () =>
      (await import("./plugin.set_enabled")).handler as CapabilityHandlerFn,
  );
  registerHandler(
    "set_plugin_secret",
    async () =>
      (await import("./plugin.credential.set_secret"))
        .handler as CapabilityHandlerFn,
  );
  registerHandler(
    "reauth_plugin_credential",
    async () =>
      (await import("./plugin.credential.reauth"))
        .handler as CapabilityHandlerFn,
  );
  registerHandler(
    "revoke_plugin_credential",
    async () =>
      (await import("./plugin.credential.revoke"))
        .handler as CapabilityHandlerFn,
  );
  registerHandler(
    "list_notifications",
    async () =>
      (await import("./notification.list")).handler as CapabilityHandlerFn,
  );
  registerHandler(
    "mark_notification",
    async () =>
      (await import("./notification.mark")).handler as CapabilityHandlerFn,
  );
  registerHandler(
    "set_auth_alerts",
    async () =>
      (await import("./plugin.settings.set_auth_alerts"))
        .handler as CapabilityHandlerFn,
  );
  registerHandler(
    "run_workflow",
    async () =>
      (await import("./workflow.run"))
        .workflowRunHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "get_workflow_status",
    async () =>
      (await import("./workflow.status"))
        .workflowStatusHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "cancel_workflow",
    async () =>
      (await import("./workflow.cancel"))
        .workflowCancelHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "list_workspace_members",
    async () =>
      (await import("./workspace.member.list"))
        .workspaceMemberListHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "get_budget_policy",
    async () =>
      (await import("./workspace.budget_policy.read"))
        .workspaceBudgetPolicyReadHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "update_budget_policy",
    async () =>
      (await import("./workspace.budget_policy.write"))
        .workspaceBudgetPolicyWriteHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "send_workspace_invite",
    async () =>
      (await import("./workspace.invite.send"))
        .workspaceInviteSendHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "post_conversation_message",
    async () =>
      (await import("./conversation.chat"))
        .conversationChatHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "create_image",
    async () =>
      (await import("./image.create"))
        .imageCreateHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "list_images",
    async () =>
      (await import("./image.list")).imageListHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "analyze_image",
    async () =>
      (await import("./image.analyze"))
        .imageAnalyzeHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "create_document",
    async () =>
      (await import("./document.create"))
        .documentCreateHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "list_documents",
    async () =>
      (await import("./document.list"))
        .documentListHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "read_document",
    async () =>
      (await import("./document.read"))
        .documentReadHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "list_automations",
    async () =>
      (await import("./automation.list"))
        .automationListHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "get_automation",
    async () =>
      (await import("./automation.get"))
        .automationGetHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "create_automation",
    async () =>
      (await import("./automation.create"))
        .automationCreateHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "update_automation",
    async () =>
      (await import("./automation.update"))
        .automationUpdateHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "enable_automation",
    async () =>
      (await import("./automation.enable"))
        .automationEnableHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "disable_automation",
    async () =>
      (await import("./automation.disable"))
        .automationDisableHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "trigger_automation",
    async () =>
      (await import("./automation.trigger"))
        .automationTriggerHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "list_workspace_skills",
    async () =>
      (await import("./skill.workspace.list"))
        .skillWorkspaceListHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "install_skill",
    async () =>
      (await import("./skill.workspace.install"))
        .skillWorkspaceInstallHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "list_skill_versions",
    async () =>
      (await import("./skill.version.list"))
        .skillVersionListHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "get_skill_version",
    async () =>
      (await import("./skill.version.get"))
        .skillVersionGetHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "upload_skill_version",
    async () =>
      (await import("./skill.version.upload"))
        .skillVersionUploadHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "activate_skill_version",
    async () =>
      (await import("./skill.version.activate"))
        .skillVersionActivateHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "edit_skill",
    async () =>
      (await import("./skill.edit")).skillEditHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "export_skill",
    async () =>
      (await import("./skill.export"))
        .skillExportHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "get_skill_metrics",
    async () =>
      (await import("./skill.metrics.read"))
        .skillMetricsReadHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "author_skill",
    async () =>
      (await import("./skill.author"))
        .skillAuthorHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "draft_skill",
    async () =>
      (await import("./skill.draft")).skillDraftHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "revise_skill",
    async () =>
      (await import("./skill.revise"))
        .skillReviseHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "create_skill",
    async () =>
      (await import("./skill.create"))
        .skillCreateHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "set_skill_enabled",
    async () =>
      (await import("./skill.enable"))
        .skillEnableHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "record_execution",
    async () =>
      (await import("./agent.execution.record"))
        .agentExecutionRecordHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "get_message_execution",
    async () =>
      (await import("./chat.message.execution"))
        .chatMessageExecutionHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "create_connection",
    async () =>
      (await import("./connection.create"))
        .connectionCreateHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "list_connections",
    async () =>
      (await import("./connection.list"))
        .connectionListHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "get_connection",
    async () =>
      (await import("./connection.get"))
        .connectionGetHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "delete_connection",
    async () =>
      (await import("./connection.delete"))
        .connectionDeleteHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "update_connection",
    async () =>
      (await import("./connection.update"))
        .connectionUpdateHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "pause_connection",
    async () =>
      (await import("./connection.pause"))
        .connectionPauseHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "preview_connection",
    async () =>
      (await import("./connection.preview"))
        .connectionPreviewHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "get_connection_mappings",
    async () =>
      (await import("./connection.mappings.get"))
        .connectionMappingsGetHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "set_connection_mappings",
    async () =>
      (await import("./connection.mappings.set"))
        .connectionMappingsSetHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "suggest_connection_mappings",
    async () =>
      (await import("./connection.mappings.suggest"))
        .connectionMappingsSuggestHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "upsert_node",
    async () =>
      (await import("./graph.node.upsert"))
        .graphNodeUpsertHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "add_node_label",
    async () =>
      (await import("./graph.node_label.add"))
        .graphNodeLabelAddHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "remove_node_label",
    async () =>
      (await import("./graph.node_label.remove"))
        .graphNodeLabelRemoveHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "get_node_labels",
    async () =>
      (await import("./graph.node_label.get"))
        .graphNodeLabelsGetHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "get_node",
    async () =>
      (await import("./graph.node.get"))
        .graphNodeGetHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "delete_node",
    async () =>
      (await import("./graph.node.delete"))
        .graphNodeDeleteHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "search_nodes",
    async () =>
      (await import("./graph.node.search"))
        .graphNodeSearchHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "search_graph",
    async () =>
      (await import("./graph.search"))
        .graphSearchHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "upsert_edge",
    async () =>
      (await import("./graph.edge.upsert"))
        .graphEdgeUpsertHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "delete_edge",
    async () =>
      (await import("./graph.edge.delete"))
        .graphEdgeDeleteHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "run_cypher",
    async () =>
      (await import("./graph.cypher"))
        .graphCypherHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "search_web",
    async () =>
      (await import("./web.search")).webSearchHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "fetch_web_page",
    async () =>
      (await import("./web.fetch")).webFetchHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "start_research_swarm",
    async () =>
      (await import("./research.swarm.start"))
        .researchSwarmStartHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "get_research_status",
    async () =>
      (await import("./research.swarm.status"))
        .researchSwarmStatusHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "edit_repo_file",
    async () =>
      (await import("./agent.repo.edit"))
        .agentRepoEditHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "create_repo",
    async () =>
      (await import("./repo.create")).repoCreateHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "put_repo_file",
    async () =>
      (await import("./repo.file.put"))
        .repoFilePutHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "fork_repo",
    async () =>
      (await import("./repo.fork")).repoForkHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "create_branch",
    async () =>
      (await import("./repo.branch.create"))
        .repoBranchCreateHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "list_branches",
    async () =>
      (await import("./repo.branch.list"))
        .repoBranchListHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "open_pr",
    async () =>
      (await import("./repo.pr.open")).repoPrOpenHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "get_pr",
    async () =>
      (await import("./repo.pr.get")).repoPrGetHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "get_pr_diff",
    async () =>
      (await import("./repo.pr.diff")).repoPrDiffHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "get_ci_status",
    async () =>
      (await import("./repo.ci.status"))
        .repoCiStatusHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "sync_repo",
    async () =>
      (await import("./repo.sync")).repoSyncHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "configure_repo",
    async () =>
      (await import("./repo.configure"))
        .repoConfigureHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "pause_repo",
    async () =>
      (await import("./repo.pause")).repoPauseHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "resume_repo",
    async () =>
      (await import("./repo.resume")).repoResumeHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "get_repo_metrics",
    async () =>
      (await import("./repo.metrics"))
        .repoMetricsHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "install_integration",
    async () =>
      (await import("./integration.install"))
        .integrationInstallHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "configure_integration",
    async () =>
      (await import("./integration.configure"))
        .integrationConfigureHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "list_integrations",
    async () =>
      (await import("./integration.list"))
        .integrationListHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "get_integration",
    async () =>
      (await import("./integration.get"))
        .integrationGetHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "sync_integration",
    async () =>
      (await import("./integration.sync"))
        .integrationSyncHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "get_integration_metrics",
    async () =>
      (await import("./integration.metrics"))
        .integrationMetricsHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "delete_integration",
    async () =>
      (await import("./integration.delete"))
        .integrationDeleteHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "get_plugin_schema",
    async () =>
      (await import("./plugin.schema.get"))
        .pluginSchemaGetHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "validate_plugin_schema",
    async () =>
      (await import("./plugin.schema.validate"))
        .pluginSchemaValidateHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "list_plugin_versions",
    async () =>
      (await import("./plugin.version.list"))
        .pluginVersionListHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "approve_semantic_edge",
    async () =>
      (await import("./semantic.edge.approve"))
        .semanticEdgeApproveHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "infer_semantic_edges",
    async () =>
      (await import("./semantic.edge.infer"))
        .semanticEdgeInferHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "list_semantic_edges",
    async () =>
      (await import("./semantic.edge.list"))
        .semanticEdgeListHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "suggest_semantic_edges",
    async () =>
      (await import("./semantic.edge.suggest"))
        .semanticEdgeSuggestHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "list_nodes",
    async () =>
      (await import("./graph.node.list"))
        .graphNodeListHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "export_graph",
    async () =>
      (await import("./graph.export"))
        .graphExportHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "get_graph_stats",
    async () =>
      (await import("./graph.stats")).graphStatsHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "query_ontology",
    async () =>
      (await import("./ontology.query"))
        .ontologyQueryHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "get_ontology_neighbors",
    async () =>
      (await import("./ontology.neighbors"))
        .ontologyNeighborsHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "query_audit_log",
    async () =>
      (await import("./audit.log.query"))
        .auditLogQueryHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "list_capability_registry",
    async () =>
      (await import("./capability.registry.list"))
        .capabilityRegistryListHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "get_capability_registry",
    async () =>
      (await import("./capability.registry.get"))
        .capabilityRegistryGetHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "list_iam_roles",
    async () =>
      (await import("./iam.role.list"))
        .iamRoleListHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "get_auth_alerts",
    async () =>
      (await import("./plugin.settings.get_auth_alerts"))
        .pluginSettingsGetAuthAlertsHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "search_command_menu",
    async () =>
      (await import("./command.menu.search"))
        .commandMenuSearchHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "suggest_commands",
    async () =>
      (await import("./command.menu.suggest"))
        .commandMenuSuggestHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "search_references",
    async () =>
      (await import("./reference.search"))
        .referenceSearchHandler as CapabilityHandlerFn,
  );
  // ── Schema Registry ───────────────────────────────────────────────────────────
  registerHandler(
    "get_schema_registry",
    async () =>
      (await import("./schema.registry.get"))
        .schemaRegistryGetHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "get_registry_config",
    async () =>
      (await import("./schema.registry.config"))
        .schemaRegistryConfigHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "list_schemas",
    async () =>
      (await import("./schema.list")).schemaListHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "toggle_schema",
    async () =>
      (await import("./schema.toggle"))
        .schemaToggleHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "upsert_schema_label",
    async () =>
      (await import("./schema.label.upsert"))
        .schemaLabelUpsertHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "delete_schema_label",
    async () =>
      (await import("./schema.label.delete"))
        .schemaLabelDeleteHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "delete_schema",
    async () =>
      (await import("./schema.delete"))
        .schemaDeleteHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "upsert_schema_relationship",
    async () =>
      (await import("./schema.relationship.upsert"))
        .schemaRelationshipUpsertHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "delete_schema_relationship",
    async () =>
      (await import("./schema.relationship.delete"))
        .schemaRelationshipDeleteHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "upsert_schema_property",
    async () =>
      (await import("./schema.property.upsert"))
        .schemaPropertyUpsertHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "delete_schema_property",
    async () =>
      (await import("./schema.property.delete"))
        .schemaPropertyDeleteHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "create_schema_version",
    async () =>
      (await import("./schema.version.create"))
        .schemaVersionCreateHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "pin_schema_version",
    async () =>
      (await import("./schema.version.pin"))
        .schemaVersionPinHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "list_schema_versions",
    async () =>
      (await import("./schema.version.list"))
        .schemaVersionListHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "diff_schema_versions",
    async () =>
      (await import("./schema.version.diff"))
        .schemaVersionDiffHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "export_schema",
    async () =>
      (await import("./schema.export"))
        .schemaExportHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "recommend_schema",
    async () =>
      (await import("./schema.recommend"))
        .schemaRecommendHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "run_schema_chat",
    async () =>
      (await import("./schema.chat")).schemaChatHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "setup_schema",
    async () =>
      (await import("./schema.setup"))
        .schemaSetupHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "dispatch_schema_reconcile",
    async () =>
      (await import("./schema.reconcile.dispatch"))
        .schemaReconcileDispatchHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "get_reconcile_status",
    async () =>
      (await import("./schema.reconcile.status"))
        .schemaReconcileStatusHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "validate_schema_node",
    async () =>
      (await import("./schema.validate.node"))
        .schemaValidateNodeHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "validate_schema_relationship",
    async () =>
      (await import("./schema.validate.relationship"))
        .schemaValidateRelationshipHandler as CapabilityHandlerFn,
  );
  // Environments + credential vault (Spec: 2026-06-24-credential-vault-…).
  registerHandler(
    "create_environment",
    async () =>
      (await import("./environment.create"))
        .environmentCreateHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "list_environments",
    async () =>
      (await import("./environment.list"))
        .environmentListHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "get_environment",
    async () =>
      (await import("./environment.get"))
        .environmentGetHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "update_environment",
    async () =>
      (await import("./environment.update"))
        .environmentUpdateHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "delete_environment",
    async () =>
      (await import("./environment.delete"))
        .environmentDeleteHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "set_default_environment",
    async () =>
      (await import("./environment.set_default"))
        .environmentSetDefaultHandler as CapabilityHandlerFn,
  );
  // Sandbox templates + portable artifacts + agent-environment bindings (Spec §5.2–§5.6).
  registerHandler(
    "create_sandbox_template",
    async () =>
      (await import("./sandbox.template.create"))
        .sandboxTemplateCreateHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "list_sandbox_templates",
    async () =>
      (await import("./sandbox.template.list"))
        .sandboxTemplateListHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "get_sandbox_template",
    async () =>
      (await import("./sandbox.template.get"))
        .sandboxTemplateGetHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "update_sandbox_template",
    async () =>
      (await import("./sandbox.template.update"))
        .sandboxTemplateUpdateHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "delete_sandbox_template",
    async () =>
      (await import("./sandbox.template.delete"))
        .sandboxTemplateDeleteHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "set_default_sandbox_template",
    async () =>
      (await import("./sandbox.template.set_default"))
        .sandboxTemplateSetDefaultHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "set_sandbox_template_tools",
    async () =>
      (await import("./sandbox.template.set_tools"))
        .sandboxTemplateSetToolsHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "export_sandbox_template",
    async () =>
      (await import("./sandbox.template.export"))
        .sandboxTemplateExportHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "import_sandbox_template",
    async () =>
      (await import("./sandbox.template.import"))
        .sandboxTemplateImportHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "bind_agent_environment",
    async () =>
      (await import("./agent.environment.bind"))
        .agentEnvironmentBindHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "unbind_agent_environment",
    async () =>
      (await import("./agent.environment.unbind"))
        .agentEnvironmentUnbindHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "list_agent_environments",
    async () =>
      (await import("./agent.environment.list"))
        .agentEnvironmentListHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "upsert_secret_key",
    async () =>
      (await import("./secret.key.upsert"))
        .secretKeyUpsertHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "list_secret_keys",
    async () =>
      (await import("./secret.key.list"))
        .secretKeyListHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "delete_secret_key",
    async () =>
      (await import("./secret.key.delete"))
        .secretKeyDeleteHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "set_secret_value",
    async () =>
      (await import("./secret.value.set"))
        .secretValueSetHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "unset_secret_value",
    async () =>
      (await import("./secret.value.unset"))
        .secretValueUnsetHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "import_env_secrets",
    async () =>
      (await import("./secret.import_env"))
        .secretImportEnvHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "reveal_secret",
    async () =>
      (await import("./secret.reveal"))
        .secretRevealHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "export_secrets",
    async () =>
      (await import("./secret.export"))
        .secretExportHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "get_code_map",
    async () =>
      (await import("./code.map")).codeMapHandler as CapabilityHandlerFn,
  );
  // ── Evals v1 ──────────────────────────────────────────────────────────────────
  registerHandler(
    "create_dataset",
    async () =>
      (await import("./eval.dataset.create"))
        .evalDatasetCreateHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "list_datasets",
    async () =>
      (await import("./eval.dataset.list"))
        .evalDatasetListHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "get_dataset",
    async () =>
      (await import("./eval.dataset.get"))
        .evalDatasetGetHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "add_dataset_item",
    async () =>
      (await import("./eval.dataset_item.add"))
        .evalDatasetItemAddHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "create_trace_dataset",
    async () =>
      (await import("./eval.dataset.from_traces"))
        .evalDatasetFromTracesHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "start_eval_run",
    async () =>
      (await import("./eval.run.start"))
        .evalRunStartHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "get_eval_status",
    async () =>
      (await import("./eval.run.status"))
        .evalRunStatusHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "get_eval_run",
    async () =>
      (await import("./eval.run.get")).evalRunGetHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "list_eval_runs",
    async () =>
      (await import("./eval.run.list"))
        .evalRunListHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "get_eval_run_series",
    async () =>
      (await import("./eval.run.series"))
        .evalRunSeriesHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "get_routing_policy",
    async () =>
      (await import("./router.policy.get"))
        .routerPolicyGetHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "set_routing_policy",
    async () =>
      (await import("./router.policy.set"))
        .routerPolicySetHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "list_routing_stats",
    async () =>
      (await import("./router.stats.list"))
        .routerStatsListHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "preview_routing_decision",
    async () =>
      (await import("./router.decision.preview"))
        .routerDecisionPreviewHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "submit_run_evidence",
    async () =>
      (await import("./run.evidence.submit"))
        .runEvidenceSubmitHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "list_run_evidence",
    async () =>
      (await import("./run.evidence.list"))
        .runEvidenceListHandler as CapabilityHandlerFn,
  );
});

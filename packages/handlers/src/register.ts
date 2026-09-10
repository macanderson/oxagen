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
    "get_spend_budget",
    async () =>
      (await import("./billing.budget.get"))
        .billingBudgetGetHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "set_spend_budget",
    async () =>
      (await import("./billing.budget.set"))
        .billingBudgetSetHandler as CapabilityHandlerFn,
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
    "get_data_plane",
    async () =>
      (await import("./org.data_plane.get"))
        .orgDataPlaneGetHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "set_data_plane",
    async () =>
      (await import("./org.data_plane.set"))
        .orgDataPlaneSetHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "set_model_credential",
    async () =>
      (await import("./org.model_credential.set"))
        .orgModelCredentialSetHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "get_model_credential",
    async () =>
      (await import("./org.model_credential.get"))
        .orgModelCredentialGetHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "delete_model_credential",
    async () =>
      (await import("./org.model_credential.delete"))
        .orgModelCredentialDeleteHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "verify_model_credential",
    async () =>
      (await import("./org.model_credential.verify"))
        .orgModelCredentialVerifyHandler as CapabilityHandlerFn,
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
    "publish_tool_declaration",
    async () =>
      (await import("./tool.declaration.publish"))
        .toolDeclarationPublishHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "list_tool_declarations",
    async () =>
      (await import("./tool.declaration.list"))
        .toolDeclarationListHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "publish_context_record",
    async () =>
      (await import("./context.record.publish"))
        .contextRecordPublishHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "list_context_records",
    async () =>
      (await import("./context.record.list"))
        .contextRecordListHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "promote_context_record",
    async () =>
      (await import("./context.record.promote"))
        .contextRecordPromoteHandler as CapabilityHandlerFn,
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
    "list_branches",
    async () =>
      (await import("./repo.branch.list"))
        .repoBranchListHandler as CapabilityHandlerFn,
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
    "list_nodes",
    async () =>
      (await import("./graph.node.list"))
        .graphNodeListHandler as CapabilityHandlerFn,
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
    "create_stella_enrollment",
    async () =>
      (await import("./telemetry.stella.enroll"))
        .telemetryStellaEnrollHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "ingest_stella_operational_telemetry",
    async () =>
      (await import("./telemetry.stella.ingest"))
        .telemetryStellaIngestHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "create_tacho_enrollment",
    async () =>
      (await import("./tacho.enrollment.create"))
        .tachoEnrollmentCreateHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "revoke_tacho_enrollment",
    async () =>
      (await import("./tacho.enrollment.revoke"))
        .tachoEnrollmentRevokeHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "ingest_tacho_events",
    async () =>
      (await import("./tacho.events.ingest"))
        .tachoEventsIngestHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "get_tacho_bundle",
    async () =>
      (await import("./tacho.bundle.get"))
        .tachoBundleGetHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "dispatch_tacho_command",
    async () =>
      (await import("./tacho.command.dispatch"))
        .tachoCommandDispatchHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "fetch_tacho_commands",
    async () =>
      (await import("./tacho.command.fetch"))
        .tachoCommandFetchHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "list_tacho_hosts",
    async () =>
      (await import("./tacho.host.list"))
        .tachoHostListHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "list_tacho_sessions",
    async () =>
      (await import("./tacho.session.list"))
        .tachoSessionListHandler as CapabilityHandlerFn,
  );
  registerHandler(
    "get_tacho_session",
    async () =>
      (await import("./tacho.session.get"))
        .tachoSessionGetHandler as CapabilityHandlerFn,
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
  // Agent ↔ environment bindings — which vault an agent identity may resolve.
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
  // ── Evals v1 ──────────────────────────────────────────────────────────────────
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
    "list_model_capabilities",
    async () =>
      (await import("./model.capability.list"))
        .modelCapabilityListHandler as CapabilityHandlerFn,
  );
});

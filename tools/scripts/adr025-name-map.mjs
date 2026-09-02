// adr025-name-map.mjs — the authoritative old-dotted → new-snake capability
// name mapping for the ADR-025 verb-first snake_case rename wave.
//
// Shape: verb_noun or verb_noun_qualifier. Imperative verb FIRST. Lowercase
// [a-z0-9] words joined by "_". 2–3 words (a 4th only where uniqueness demands
// it — flagged in FOUR_WORD below). Globally unique across the registry.
//
// The rename itself has landed; nothing in the repo imports these exports any
// more. The table is retained only as the lookup the reland runbook needs —
// adr025-reland-custom-role-grant-remap.sql was generated from it, and
// re-deriving that SQL requires the same old→new pairs. When the reland is
// complete this file and that SQL go together.

export const MAP = {
  // ── a2a ──────────────────────────────────────────────────────────────────
  "a2a.card.get": "get_a2a_card",

  // ── agent ────────────────────────────────────────────────────────────────
  "agent.approval.resolve": "resolve_approval",
  "agent.background_task.cancel": "cancel_background_task",
  "agent.background_task.read": "get_background_task",
  "agent.background_task.start": "start_background_task",
  "agent.code.execute": "execute_code",
  "agent.compose": "run_capability_chain",
  "agent.debug.trace": "debug_execution",
  "agent.definition.create": "create_agent_def",
  "agent.definition.get": "get_agent_def",
  "agent.definition.list": "list_agent_defs",
  "agent.definition.publish": "publish_agent_def",
  "agent.definition.suggest": "suggest_agent_def",
  "agent.definition.update": "update_agent_def",
  "agent.deploy": "deploy_agent",
  "agent.execution.list": "list_executions",
  "agent.execution.record": "record_execution",
  "agent.feature.verify": "verify_feature",
  "agent.file_lock.acquire": "acquire_file_lock",
  "agent.file_lock.list": "list_file_locks",
  "agent.file_lock.release": "release_file_lock",
  "agent.mcp_consent.list": "list_mcp_consents",
  "agent.mcp_consent.resolve": "resolve_mcp_consent",
  "agent.mcp.delete": "delete_mcp_server",
  "agent.mcp.list": "list_mcp_servers",
  "agent.mcp.register": "register_mcp_server",
  "agent.mcp.set_enabled": "set_mcp_enabled",
  "agent.memory_citation.list": "list_memory_citations",
  "agent.memory_evidence.attach": "attach_memory_evidence",
  "agent.memory_import.commit": "commit_memory_import",
  "agent.memory_import.parse": "parse_memory_import",
  "agent.memory_policy.read": "get_memory_policy",
  "agent.memory_policy.write": "update_memory_policy",
  "agent.memory_promotion.list": "list_memory_promotions",
  "agent.memory.cite": "cite_memory",
  "agent.memory.delete": "delete_memory",
  "agent.memory.list": "list_memories",
  "agent.memory.promote": "promote_memory",
  "agent.memory.recall": "recall_memory",
  "agent.memory.remember": "save_memory",
  "agent.memory.update": "update_memory",
  "agent.memory.write": "write_memory",
  "agent.plan.approve": "approve_plan",
  "agent.plan.create": "create_plan",
  "agent.repo.edit": "edit_repo_file",
  "agent.sandbox_file.list": "list_sandbox_files",
  "agent.sandbox_file.read": "read_sandbox_file",
  "agent.sandbox.exec": "run_sandbox_command",
  "agent.sandbox.snapshot": "snapshot_sandbox",
  "agent.sandbox.start": "start_sandbox",
  "agent.sandbox.stop": "stop_sandbox",
  "agent.skill.list": "list_agent_skills",
  "agent.skill.load": "load_skill",
  "agent.subagent_fanout.get": "get_subagent_fanout",
  "agent.subagent_fanout.list": "list_subagent_fanouts",
  "agent.subagent_result.get": "get_subagent_result",
  "agent.subagent.aggregate": "aggregate_subagents",
  "agent.subagent.cancel": "cancel_subagent",
  "agent.subagent.dispatch": "dispatch_subagent",
  "agent.subagent.logs": "get_subagent_logs",
  "agent.subagent.siblings": "list_subagent_siblings",
  "agent.tool.list": "list_agent_tools",
  "agent.trace.get": "get_execution_trace",
  "agent.trigger.create": "create_trigger",
  "agent.trigger.delete": "delete_trigger",
  "agent.trigger.list": "list_triggers",
  "agent.trigger.update": "update_trigger",
  "agent.ui.render": "render_agent_ui",

  // ── api ──────────────────────────────────────────────────────────────────
  "api.key.create": "create_api_key",
  "api.key.revoke": "revoke_api_key",
  "api.key.rotate": "rotate_api_key",

  // ── archive / asset ───────────────────────────────────────────────────────
  "archive.create": "create_archive",
  "asset.upload": "upload_asset",

  // ── audit ─────────────────────────────────────────────────────────────────
  "audit.log.query": "query_audit_log",

  // ── automation ────────────────────────────────────────────────────────────
  "automation.create": "create_automation",
  "automation.disable": "disable_automation",
  "automation.enable": "enable_automation",
  "automation.list": "list_automations",
  "automation.trigger": "trigger_automation",
  "automation.update": "update_automation",

  // ── billing ───────────────────────────────────────────────────────────────
  "billing.credits.purchase": "purchase_credits",
  "billing.subscription_upgrade.start": "start_subscription_upgrade",
  "billing.subscription.read": "get_subscription",
  "billing.usage.breakdown": "get_usage_breakdown",

  // ── browser (page-interaction family) ─────────────────────────────────────
  "browser.click": "click_page",
  "browser.fill": "fill_page",
  "browser.navigate": "navigate_page",
  "browser.read": "read_page",
  "browser.refresh": "refresh_page",
  "browser.screenshot": "screenshot_page",
  "browser.submit": "submit_page",

  // ── budget (per-USER; distinct from workspace.budget_policy — verified) ────
  "budget.policy.read": "get_user_budget",
  "budget.policy.write": "update_user_budget",

  // ── chat ──────────────────────────────────────────────────────────────────
  "chat.message.execution": "get_message_execution",
  "chat.message.send": "send_message",

  // ── code ──────────────────────────────────────────────────────────────────
  "code.diff": "diff_code",
  "code.format": "format_code",
  "code.patch": "patch_code",

  // ── command ───────────────────────────────────────────────────────────────
  "command.menu.search": "search_command_menu",
  "command.menu.suggest": "suggest_commands",

  // ── connection ────────────────────────────────────────────────────────────
  "connection.create": "create_connection",
  "connection.delete": "delete_connection",
  "connection.get": "get_connection",
  "connection.list": "list_connections",
  "connection.mappings.get": "get_connection_mappings",
  "connection.mappings.set": "set_connection_mappings",
  "connection.mappings.suggest": "suggest_connection_mappings",
  "connection.pause": "pause_connection",
  "connection.preview": "preview_connection",
  "connection.update": "update_connection",

  // ── conversation ──────────────────────────────────────────────────────────
  "conversation.archive": "archive_conversation",
  "conversation.attachment.add": "add_conversation_attachment",
  "conversation.chat": "post_conversation_message",
  "conversation.delete": "delete_conversation",
  "conversation.export": "export_conversation",
  "conversation.files.list": "list_conversation_files",
  "conversation.list": "list_conversations",
  "conversation.purge": "purge_conversations",
  "conversation.rename": "rename_conversation",

  // ── document ──────────────────────────────────────────────────────────────
  "document.create": "create_document",
  "document.generate": "generate_document",
  "document.list": "list_documents",
  "document.pdf.create": "create_pdf",
  "document.read": "read_document",

  // ── environment ───────────────────────────────────────────────────────────
  "environment.create": "create_environment",
  "environment.delete": "delete_environment",
  "environment.get": "get_environment",
  "environment.list": "list_environments",
  "environment.set_default": "set_default_environment",
  "environment.update": "update_environment",

  // ── eval ──────────────────────────────────────────────────────────────────
  "eval.dataset_item.add": "add_dataset_item",
  "eval.dataset.create": "create_dataset",
  "eval.dataset.from_traces": "create_trace_dataset",
  "eval.dataset.get": "get_dataset",
  "eval.dataset.list": "list_datasets",
  "eval.run.get": "get_eval_run",
  "eval.run.start": "start_eval_run",
  "eval.run.status": "get_eval_status",

  // ── form ──────────────────────────────────────────────────────────────────
  "form.fill": "fill_form",

  // ── graph ─────────────────────────────────────────────────────────────────
  "graph.node_label.get": "get_node_labels",
  "graph.node.get": "get_node",
  "graph.node.list": "list_nodes",
  "graph.node.search": "search_nodes",
  "graph.search": "search_graph",
  "graph.stats": "get_graph_stats",

  // ── image ─────────────────────────────────────────────────────────────────
  "image.analyze": "analyze_image",
  "image.create": "create_image",
  "image.generate": "generate_image",
  "image.list": "list_images",

  // ── integration (distinct noun from plugin — verified) ────────────────────
  "integration.configure": "configure_integration",
  "integration.delete": "delete_integration",
  "integration.get": "get_integration",
  "integration.install": "install_integration",
  "integration.list": "list_integrations",
  "integration.metrics": "get_integration_metrics",
  "integration.sync": "sync_integration",

  // ── generated content ─────────────────────────────────────────────────────
  "markdown.generate": "generate_markdown",
  "mermaid.generate": "generate_mermaid",
  "svg.generate": "generate_svg",
  "video.generate": "generate_video",

  // ── notification ──────────────────────────────────────────────────────────
  "notification.list": "list_notifications",
  "notification.mark": "mark_notification",

  // ── ontology ──────────────────────────────────────────────────────────────
  "ontology.neighbors": "get_ontology_neighbors",
  "ontology.query": "query_ontology",

  // ── org ───────────────────────────────────────────────────────────────────
  "org.create": "create_org",
  "org.list": "list_orgs",
  "org.member_invite.accept": "accept_member_invite",
  "org.member_invite.decline": "decline_member_invite",
  "org.member_role.change": "change_member_role",
  "org.member.add": "add_org_member",
  "org.member.remove": "remove_org_member",
  "org.settings.read": "get_org_settings",
  "org.settings.write": "update_org_settings",

  // ── plugin ────────────────────────────────────────────────────────────────
  "plugin.catalog.browse": "browse_plugin_catalog",
  "plugin.catalog.get": "get_catalog_plugin",
  "plugin.catalog.sync": "sync_plugin_catalog",
  "plugin.credential.reauth": "reauth_plugin_credential",
  "plugin.credential.set_secret": "set_plugin_secret",
  "plugin.org.install": "install_plugin",
  "plugin.org.install_bulk": "install_plugins_bulk",
  "plugin.org.list": "list_plugins",
  "plugin.org.set_enabled": "set_plugin_enabled",
  "plugin.org.uninstall": "uninstall_plugin",
  "plugin.registry.add": "add_plugin_registry",
  "plugin.registry.list": "list_plugin_registries",
  "plugin.registry.remove": "remove_plugin_registry",
  "plugin.schema.get": "get_plugin_schema",
  "plugin.schema.validate": "validate_plugin_schema",
  "plugin.settings.set_auth_alerts": "set_auth_alerts",
  "plugin.version.list": "list_plugin_versions",
  "plugin.workspace.set_enabled": "set_plugin_enabled",

  // ── privacy ───────────────────────────────────────────────────────────────
  "privacy.data.erase": "erase_data",
  "privacy.data.export": "export_data",

  // ── prompt ────────────────────────────────────────────────────────────────
  "prompt.settings.read": "get_prompt_settings",
  "prompt.settings.write": "update_prompt_settings",

  // ── repo ──────────────────────────────────────────────────────────────────
  "repo.branch.create": "create_branch",
  "repo.ci.status": "get_ci_status",
  "repo.configure": "configure_repo",
  "repo.create": "create_repo",
  "repo.file.put": "put_repo_file",
  "repo.fork": "fork_repo",
  "repo.metrics": "get_repo_metrics",
  "repo.pause": "pause_repo",
  "repo.pr.diff": "get_pr_diff",
  "repo.pr.get": "get_pr",
  "repo.pr.open": "open_pr",
  "repo.resume": "resume_repo",
  "repo.sync": "sync_repo",

  // ── research ──────────────────────────────────────────────────────────────
  "research.swarm.start": "start_research_swarm",
  "research.swarm.status": "get_research_status",

  // ── schema ────────────────────────────────────────────────────────────────
  "schema.chat": "run_schema_chat",
  "schema.delete": "delete_schema",
  "schema.export": "export_schema",
  "schema.label.delete": "delete_schema_label",
  "schema.label.upsert": "upsert_schema_label",
  "schema.list": "list_schemas",
  "schema.property.delete": "delete_schema_property",
  "schema.property.upsert": "upsert_schema_property",
  "schema.recommend": "recommend_schema",
  "schema.reconcile.dispatch": "dispatch_schema_reconcile",
  "schema.reconcile.status": "get_reconcile_status",
  "schema.registry.config": "get_registry_config",
  "schema.registry.get": "get_schema_registry",
  "schema.relationship.delete": "delete_schema_relationship",
  "schema.relationship.upsert": "upsert_schema_relationship",
  "schema.setup": "setup_schema",
  "schema.toggle": "toggle_schema",
  "schema.validate.node": "validate_schema_node",
  "schema.validate.relationship": "validate_schema_relationship",
  "schema.version.create": "create_schema_version",
  "schema.version.diff": "diff_schema_versions",
  "schema.version.list": "list_schema_versions",
  "schema.version.pin": "pin_schema_version",

  // ── secret ────────────────────────────────────────────────────────────────
  "secret.export": "export_secrets",
  "secret.import_env": "import_env_secrets",
  "secret.key.delete": "delete_secret_key",
  "secret.key.list": "list_secret_keys",
  "secret.key.upsert": "upsert_secret_key",
  "secret.reveal": "reveal_secret",
  "secret.value.set": "set_secret_value",
  "secret.value.unset": "unset_secret_value",

  // ── semantic ──────────────────────────────────────────────────────────────
  "semantic.relationship.approve": "approve_semantic_relationship",
  "semantic.relationship.infer": "infer_semantic_relationships",
  "semantic.relationship.list": "list_semantic_relationships",
  "semantic.relationship.suggest": "suggest_semantic_relationships",

  // ── skill ─────────────────────────────────────────────────────────────────
  "skill.author": "author_skill",
  "skill.create": "create_skill",
  "skill.draft": "draft_skill",
  "skill.edit": "edit_skill",
  "skill.enable": "set_skill_enabled",
  "skill.export": "export_skill",
  "skill.metrics.read": "get_skill_metrics",
  "skill.version.activate": "activate_skill_version",
  "skill.version.get": "get_skill_version",
  "skill.version.list": "list_skill_versions",
  "skill.version.upload": "upload_skill_version",
  "skill.workspace.install": "install_skill",
  "skill.workspace.list": "list_workspace_skills",

  // ── system ────────────────────────────────────────────────────────────────
  "system.install.instructions": "get_install_instructions",

  // ── telemetry ─────────────────────────────────────────────────────────────
  "telemetry.error.cluster": "list_error_clusters",

  // ── user ──────────────────────────────────────────────────────────────────
  "user.preferences.read": "get_user_preferences",
  "user.preferences.write": "update_user_preferences",

  // ── web ───────────────────────────────────────────────────────────────────
  "web.fetch": "fetch_web_page",
  "web.search": "search_web",

  // ── workflow ──────────────────────────────────────────────────────────────
  "workflow.cancel": "cancel_workflow",
  "workflow.run": "run_workflow",
  "workflow.status": "get_workflow_status",

  // ── workspace ─────────────────────────────────────────────────────────────
  "workspace.budget_policy.read": "get_budget_policy",
  "workspace.budget_policy.write": "update_budget_policy",
  "workspace.create": "create_workspace",
  "workspace.invite.send": "send_workspace_invite",
  "workspace.list": "list_workspaces",
  "workspace.member.list": "list_workspace_members",
  "workspace.model_settings.read": "get_model_settings",
  "workspace.model_settings.write": "update_model_settings",
  "workspace.settings.read": "get_workspace_settings",
  "workspace.settings.write": "update_workspace_settings",
};

// No capability name uses a 4th word: the only four-word names were the
// scope-disambiguated set_*_plugin_enabled pair, now collapsed into the
// three-word set_plugin_enabled (see COMPLETED_MERGES).
export const FOUR_WORD = new Set([]);

// Scope-collapse merges that have been EXECUTED: two capabilities that differed
// only by scope, collapsed into one canonical name that takes the scope as an
// argument. The one handler branches on scope.
export const COMPLETED_MERGES = [
  {
    canonical: "set_plugin_enabled",
    members: ["plugin.org.set_enabled", "plugin.workspace.set_enabled"],
    argument: 'scope: "org" | "workspace"',
    reason:
      "org- vs workspace-scoped enable collapsed to set_plugin_enabled(scope); the single handler branches on scope.",
  },
];

// Verified NON-duplicates that were flagged earlier as possible duplicates —
// kept distinct (no merge), recorded here for the report.
export const VERIFIED_DISTINCT = [
  {
    pair: ["budget.policy.read/write", "workspace.budget_policy.read/write"],
    finding:
      'budget.policy.* is a per-USER personal turn budget (domain "user"); workspace.budget_policy.* is the org/workspace-governed budget. Distinct scopes → get_user_budget vs get_budget_policy.',
  },
  {
    pair: ["conversation.chat", "chat.message.send"],
    finding:
      "conversation.chat is a sync 'post a message'; chat.message.send is async and streams the assistant reply. Distinct behavior → post_conversation_message vs send_message.",
  },
  {
    pair: ["integration.*", "plugin.org.*"],
    finding:
      "Distinct nouns already (integration vs plugin-install). Kept separate; a true semantic-dedup is a product decision, not a naming merge.",
  },
];

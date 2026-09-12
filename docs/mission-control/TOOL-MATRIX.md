# Mission Control — tool traceability matrix

Generated from Appendix E of `2026-09-11-oxagen-mission-control-spec.md` joined against
the `registerCapability()` declarations in `packages/oxagen/src/contracts/`.
Regenerate with `tools/scripts/mission-control/build-matrix.mjs`.

| Grade | Meaning | Count |
|---|---|---|
| `INHERIT` | every absorbed contract resolves to a live file; input/output schema, risk grade and default effect are carried forward | 74 |
| `MERGE` | some absorbed contracts resolve, some do not | 0 |
| `NEW` | nothing resolves; the schema is genuine design work | 22 |

**96 target tools. 47 live contracts have no absorber and are deletion candidates (see bottom).**


## Organization and workspace (11)

| Tool | Grade | Inherits schema from | Risk | Effect |
|---|---|---|---|---|
| `create_org` | INHERIT | `create_org` | medium | deny |
| `update_org` | INHERIT | `update_org_settings` | medium | deny |
| `invite_member` | INHERIT | `send_workspace_invite`, `add_org_member` | medium | deny |
| `respond_to_invite` | INHERIT | `accept_member_invite`, `decline_member_invite` | low | allow |
| `set_member_role` | INHERIT | `change_member_role`, `remove_org_member` | high | deny |
| `list_members` | INHERIT | `list_workspace_members` | low | deny |
| `create_workspace` | INHERIT | `create_workspace`, `configure_repo` | medium | deny |
| `update_workspace` | INHERIT | `update_workspace_settings`, `update_memory_policy`, `update_budget_policy`, `set_routing_policy` | medium | deny |
| `list_workspaces` | INHERIT | `list_workspaces`, `list_orgs` | low | allow |
| `get_data_plane` | INHERIT | `get_data_plane` | high | deny |
| `set_data_plane` | INHERIT | `set_data_plane` | high | deny |

## Identity and access (10)

| Tool | Grade | Inherits schema from | Risk | Effect |
|---|---|---|---|---|
| `create_api_key` | INHERIT | `create_api_key` | medium | deny |
| `rotate_api_key` | INHERIT | `rotate_api_key` | high | deny |
| `revoke_api_key` | INHERIT | `revoke_api_key` | high | deny |
| `register_agent` | INHERIT | `create_agent_def`, `suggest_agent_def`, `summarize_agent_def` | low | deny |
| `update_agent` | INHERIT | `update_agent_def`, `revise_agent_def`, `publish_agent_def`, `deploy_agent` | medium | deny |
| `retire_agent` | INHERIT | `delete_agent_def` | high | deny |
| `get_agent` | INHERIT | `get_agent_def`, `get_agent_role` | low | deny |
| `list_agents` | INHERIT | `list_agent_defs` | low | deny |
| `set_agent_role` | INHERIT | `assign_agent_role`, `revoke_agent_role` | high | deny |
| `set_role_grants` | NEW | — | — | — |

## Wrapping and control (14)

| Tool | Grade | Inherits schema from | Risk | Effect |
|---|---|---|---|---|
| `enroll_host` | INHERIT | `create_tacho_enrollment` | — | deny |
| `revoke_enrollment` | INHERIT | `revoke_tacho_enrollment` | — | deny |
| `list_hosts` | INHERIT | `list_tacho_hosts` | — | deny |
| `get_policy_bundle` | INHERIT | `get_tacho_bundle`, `get_registry_config` | — | deny |
| `ingest_frames` | INHERIT | `ingest_tacho_events`, `record_execution`, `ingest_stella_operational_telemetry`, `debug_execution` | high | deny |
| `fetch_commands` | INHERIT | `fetch_tacho_commands` | — | deny |
| `dispatch_command` | INHERIT | `dispatch_tacho_command` | — | deny |
| `list_runs` | INHERIT | `list_executions`, `list_tacho_sessions` | low | deny |
| `get_run` | INHERIT | `get_tacho_session`, `get_execution_trace`, `get_message_execution` | — | deny |
| `export_run` | NEW | — | — | — |
| `list_approvals` | NEW | — | — | — |
| `resolve_approval` | INHERIT | `resolve_approval`, `resolve_mcp_consent` | low | deny |
| `send_message` | NEW | — | — | — |
| `list_messages` | NEW | — | — | — |

## Toolbelt (17)

| Tool | Grade | Inherits schema from | Risk | Effect |
|---|---|---|---|---|
| `register_tool_server` | INHERIT | `register_mcp_server`, `set_mcp_enabled` | — | deny |
| `remove_tool_server` | INHERIT | `delete_mcp_server` | — | deny |
| `list_tool_servers` | INHERIT | `list_mcp_servers`, `resolve_mcp_servers`, `list_mcp_consents` | medium | deny |
| `import_tools` | INHERIT | `list_tool_declarations`, `publish_tool_declaration`, `list_agent_tools` | low | deny |
| `approve_tool_schema` | NEW | — | — | — |
| `search_tools` | INHERIT | `search_command_menu`, `suggest_commands` | low | deny |
| `load_tools` | NEW | — | — | — |
| `set_connection` | INHERIT | `set_model_credential`, `verify_model_credential`, `upsert_secret_key`, `set_secret_value`, `set_plugin_secret`, `reauth_plugin_credential` | high | deny |
| `delete_connection` | INHERIT | `delete_connection`, `delete_model_credential`, `delete_secret_key`, `unset_secret_value`, `revoke_plugin_credential` | high | deny |
| `list_connections` | INHERIT | `list_connections`, `list_secret_keys`, `get_model_credential` | low | deny |
| `grant_mandate` | NEW | — | — | — |
| `set_approval_rules` | NEW | — | — | — |
| `revoke_mandate` | NEW | — | — | — |
| `list_mandates` | NEW | — | — | — |
| `set_policy` | NEW | — | — | — |
| `simulate_policy` | NEW | — | — | — |
| `set_kill_switch` | NEW | — | — | — |

## Ontology and knowledge (13)

| Tool | Grade | Inherits schema from | Risk | Effect |
|---|---|---|---|---|
| `link_repository` | INHERIT | `configure_repo`, `sync_repo` | medium | deny |
| `unlink_repository` | INHERIT | `pause_repo`, `delete_integration` | high | deny |
| `sync_repository` | INHERIT | `sync_repo`, `resume_repo`, `sync_integration` | medium | deny |
| `add_source` | INHERIT | `install_plugin`, `configure_integration` | medium | deny |
| `update_source` | INHERIT | `update_connection`, `set_connection_mappings`, `suggest_connection_mappings`, `pause_connection`, `preview_connection` | medium | deny |
| `remove_source` | INHERIT | `delete_connection`, `uninstall_plugin` | high | deny |
| `list_sources` | INHERIT | `list_connections`, `list_integrations`, `list_plugins`, `get_integration`, `get_integration_metrics`, `get_reconcile_status` | low | deny |
| `propose_ontology_version` | INHERIT | `recommend_schema`, `setup_schema`, `create_schema_version`, `run_schema_chat`, `pin_schema_version`, `toggle_schema`, `dispatch_schema_reconcile` | low | deny |
| `get_ontology` | INHERIT | `get_schema_registry`, `list_schema_versions`, `list_schemas`, `diff_schema_versions`, `export_schema`, `get_node_labels` | low | deny |
| `update_ontology` | INHERIT | `upsert_schema_label`, `upsert_schema_property`, `upsert_schema_relationship`, `delete_schema_label`, `delete_schema_property`, `delete_schema_relationship`, `validate_schema_node`, `validate_schema_relationship` | low | deny |
| `search_graph` | INHERIT | `search_graph`, `search_nodes`, `search_references`, `list_nodes` | low | deny |
| `expand_graph` | INHERIT | `get_ontology_neighbors`, `get_node` | low | deny |
| `query_graph` | INHERIT | `query_ontology`, `get_graph_stats` | low | deny |

## Context and steering (9)

| Tool | Grade | Inherits schema from | Risk | Effect |
|---|---|---|---|---|
| `append_record` | INHERIT | `write_memory`, `save_memory`, `attach_memory_evidence`, `cite_memory`, `cite_reference` | low | deny |
| `get_record` | NEW | — | — | — |
| `list_records` | INHERIT | `list_context_records`, `list_memories`, `list_memory_citations`, `get_citation_stats` | low | deny |
| `retract_record` | INHERIT | `delete_memory`, `demote_memory` | medium | deny |
| `recall_context` | INHERIT | `recall_memory` | low | deny |
| `propose_record` | INHERIT | `promote_memory`, `promote_context_record`, `suggest_promotion_rationales` | high | deny |
| `open_context_pr` | INHERIT | `publish_context_record` | high | deny |
| `list_proposals` | INHERIT | `list_memory_promotions` | low | deny |
| `dismiss_proposal` | INHERIT | `dismiss_memory_promotion` | low | deny |

## Spend and billing (9)

| Tool | Grade | Inherits schema from | Risk | Effect |
|---|---|---|---|---|
| `get_spend` | INHERIT | `get_usage_breakdown`, `list_routing_stats`, `get_repo_metrics` | low | deny |
| `list_findings` | INHERIT | `list_error_clusters` | low | deny |
| `get_reconciliation` | NEW | — | — | — |
| `export_statement` | NEW | — | — | — |
| `set_budget` | INHERIT | `set_spend_budget`, `get_spend_budget`, `update_user_budget`, `get_user_budget`, `get_budget_policy` | low | deny |
| `set_model_route` | INHERIT | `update_model_settings`, `get_model_settings`, `preview_routing_decision`, `get_routing_policy` | low | deny |
| `set_funding_source` | NEW | — | — | — |
| `get_subscription` | INHERIT | `get_subscription` | low | deny |
| `change_subscription` | INHERIT | `start_subscription_upgrade`, `purchase_credits` | medium | deny |

## Audit and compliance (7)

| Tool | Grade | Inherits schema from | Risk | Effect |
|---|---|---|---|---|
| `query_audit_log` | INHERIT | `query_audit_log`, `get_auth_alerts` | low | deny |
| `export_data` | INHERIT | `export_data` | low | deny |
| `erase_data` | INHERIT | `erase_data` | high | deny |
| `set_legal_hold` | NEW | — | — | — |
| `list_incidents` | NEW | — | — | — |
| `set_event_subscription` | NEW | — | — | — |
| `list_event_subscriptions` | NEW | — | — | — |

## Assistant and account (6)

| Tool | Grade | Inherits schema from | Risk | Effect |
|---|---|---|---|---|
| `ask_assistant` | INHERIT | `send_message`, `post_conversation_message`, `add_conversation_attachment` | — | deny |
| `list_conversations` | INHERIT | `list_conversations`, `rename_conversation`, `archive_conversation`, `delete_conversation`, `export_conversation`, `purge_conversations`, `list_conversation_files` | low | deny |
| `set_preferences` | INHERIT | `update_user_preferences`, `get_user_preferences`, `update_workspace_user_preferences`, `get_workspace_user_preferences`, `set_auth_alerts` | low | deny |
| `list_notifications` | INHERIT | `list_notifications` | — | deny |
| `mark_notification` | INHERIT | `mark_notification` | — | deny |
| `get_install_instructions` | INHERIT | `get_install_instructions` | low | deny |

---

## Deletion candidates — contracts no target tool absorbs (47)

| Contract | File | Domain |
|---|---|---|
| `bind_agent_environment` | `agent.environment.bind.ts` | agent |
| `commit_memory_import` | `agent.memory_import.commit.ts` | agent |
| `get_memory_policy` | `agent.memory_policy.read.ts` | agent |
| `list_agent_environments` | `agent.environment.list.ts` | agent |
| `list_agent_roles` | `agent.role.list.ts` | agent |
| `parse_memory_import` | `agent.memory_import.parse.ts` | agent |
| `unbind_agent_environment` | `agent.environment.unbind.ts` | agent |
| `update_memory` | `agent.memory.update.ts` | agent |
| `upload_asset` | `asset.upload.ts` | asset |
| `get_capability_registry` | `capability.registry.get.ts` | capability |
| `list_capability_registry` | `capability.registry.list.ts` | capability |
| `create_connection` | `connection.create.ts` | connection |
| `get_connection` | `connection.get.ts` | connection |
| `get_connection_mappings` | `connection.mappings.get.ts` | connection |
| `create_environment` | `environment.create.ts` | environment |
| `delete_environment` | `environment.delete.ts` | environment |
| `get_environment` | `environment.get.ts` | environment |
| `list_environments` | `environment.list.ts` | environment |
| `set_default_environment` | `environment.set_default.ts` | environment |
| `update_environment` | `environment.update.ts` | environment |
| `list_iam_roles` | `iam.role.list.ts` | iam |
| `install_integration` | `integration.install.ts` | integration |
| `list_model_capabilities` | `model.capability.list.ts` | model |
| `get_org_settings` | `org.settings.read.ts` | org |
| `add_plugin_registry` | `plugin.registry.add.ts` | plugin |
| `browse_plugin_catalog` | `plugin.catalog.browse.ts` | plugin |
| `get_catalog_plugin` | `plugin.catalog.get.ts` | plugin |
| `get_plugin_schema` | `plugin.schema.get.ts` | plugin |
| `install_plugins_bulk` | `plugin.org.install_bulk.ts` | plugin |
| `list_plugin_registries` | `plugin.registry.list.ts` | plugin |
| `list_plugin_versions` | `plugin.version.list.ts` | plugin |
| `remove_plugin_registry` | `plugin.registry.remove.ts` | plugin |
| `set_plugin_enabled` | `plugin.set_enabled.ts` | plugin |
| `sync_plugin_catalog` | `plugin.catalog.sync.ts` | plugin |
| `validate_plugin_schema` | `plugin.schema.validate.ts` | plugin |
| `get_ci_status` | `repo.ci.status.ts` | repo |
| `get_pr` | `repo.pr.get.ts` | repo |
| `get_pr_diff` | `repo.pr.diff.ts` | repo |
| `list_branches` | `repo.branch.list.ts` | repo |
| `delete_schema` | `schema.delete.ts` | schema |
| `export_secrets` | `secret.export.ts` | secret |
| `import_env_secrets` | `secret.import_env.ts` | secret |
| `reveal_secret` | `secret.reveal.ts` | secret |
| `create_stella_enrollment` | `telemetry.stella.enroll.ts` | telemetry |
| `get_prompt_settings` | `prompt.settings.read.ts` | workspace |
| `get_workspace_settings` | `workspace.settings.read.ts` | workspace |
| `update_prompt_settings` | `prompt.settings.write.ts` | workspace |

# ADR-025 naming mapping — final resolved (EXECUTED)

> **Historical name ledger (2026-07-21 note):** rows for retired graph mutation,
> raw Cypher, code-map, graph-sync, execution-lineage, and legacy semantic-edge
> capabilities are preserved only to explain the completed rename. They are not
> current product surfaces and must not be re-registered from this table.

**Status:** Executed on branch `feat/adr024-naming-standard`. All contract `name` fields have been rewritten to verb-first snake_case. The ADR-022 alias mechanism has been **removed** — there is one canonical name per capability, no shim. See `docs/adr/ADR-025-verb-first-snake-naming.md` for the standard.

**Totals:** 293 capabilities (294 renamed, then the scope-collapse merge removed one) · 293 globally-unique names · 0 true-duplicate merges (all flagged pairs verified DISTINCT) · 1 executed scope-collapse merge (2 members → 1) · 0 four-word names.

## Merges & collisions

### Executed scope-collapse merge
- **set_plugin_enabled(scope)** ← `plugin.org.set_enabled` + `plugin.workspace.set_enabled`. Collapsed into one capability taking `scope: "org" | "workspace"`; the single handler branches on scope (org → toggle org-listing flag; workspace → upsert/disable the workspace `agent.mcp_servers` row). The two old contracts and their route/tool/handler/docs files are deleted.

### Flagged possible-duplicates — VERIFIED DISTINCT, kept separate (no merge)
- `budget.policy.read/write` vs `workspace.budget_policy.read/write`: budget.policy.* is a per-USER personal turn budget (domain "user"); workspace.budget_policy.* is the org/workspace-governed budget. Distinct scopes → get_user_budget vs get_budget_policy.
- `conversation.chat` vs `chat.message.send`: conversation.chat is a sync 'post a message'; chat.message.send is async and streams the assistant reply. Distinct behavior → post_conversation_message vs send_message.
- `integration.*` vs `plugin.org.*`: Distinct nouns already (integration vs plugin-install). Kept separate; a true semantic-dedup is a product decision, not a naming merge.

### Collisions resolved with a 3rd/4th disambiguating word
- `list_agent_defs` (agent definitions) vs `list_subagents` — kept distinct.
- `list_agent_skills` (agent-loadable skills) vs `list_workspace_skills` (workspace skill records).
- `get_execution_lineage` vs `get_execution_trace` (both read one execution, different views).
- `upsert_graph_relationship` vs `upsert_schema_relationship` (graph data vs schema definition).
- `get_user_budget` vs `get_budget_policy` (per-user vs workspace-governed budget).
- `get_registry_config` (schema registry config) vs `get_schema_registry` (registry entry).
- (The former `set_org_plugin_enabled` / `set_workspace_plugin_enabled` four-word names are gone — merged into `set_plugin_enabled(scope)`.)

## Full mapping (294)

| old dotted name | new snake name | aliases | merged? | notes |
|---|---|---|---|---|
| `a2a.card.get` | `get_a2a_card` | `a2a.card.get` | no |  |
| `agent.approval.resolve` | `resolve_approval` | `agent.approval.resolve` | no |  |
| `agent.background_task.cancel` | `cancel_background_task` | `agent.background_task.cancel`, `agent.task.background.cancel` | no |  |
| `agent.background_task.read` | `get_background_task` | `agent.background_task.read`, `agent.task.background.read` | no |  |
| `agent.background_task.start` | `start_background_task` | `agent.background_task.start`, `agent.task.background.start` | no |  |
| `agent.code.execute` | `execute_code` | `agent.code.execute` | no |  |
| `agent.compose` | `run_capability_chain` | `agent.compose` | no |  |
| `agent.debug.trace` | `debug_execution` | `agent.debug.trace` | no |  |
| `agent.definition.create` | `create_agent_def` | `agent.definition.create` | no |  |
| `agent.definition.get` | `get_agent_def` | `agent.definition.get` | no |  |
| `agent.definition.list` | `list_agent_defs` | `agent.definition.list` | no |  |
| `agent.definition.publish` | `publish_agent_def` | `agent.definition.publish` | no |  |
| `agent.definition.suggest` | `suggest_agent_def` | `agent.definition.suggest` | no |  |
| `agent.definition.update` | `update_agent_def` | `agent.definition.update` | no |  |
| `agent.deploy` | `deploy_agent` | `agent.deploy` | no |  |
| `agent.execution.lineage` | `get_execution_lineage` | `agent.execution.lineage` | no |  |
| `agent.execution.list` | `list_executions` | `agent.execution.list` | no |  |
| `agent.execution.record` | `record_execution` | `agent.execution.record` | no |  |
| `agent.feature.verify` | `verify_feature` | `agent.feature.verify` | no |  |
| `agent.file_lock.acquire` | `acquire_file_lock` | `agent.file_lock.acquire`, `agent.file.lock.acquire` | no |  |
| `agent.file_lock.list` | `list_file_locks` | `agent.file_lock.list`, `agent.file.lock.list` | no |  |
| `agent.file_lock.release` | `release_file_lock` | `agent.file_lock.release`, `agent.file.lock.release` | no |  |
| `agent.mcp_consent.list` | `list_mcp_consents` | `agent.mcp_consent.list`, `agent.mcp.consent.list` | no |  |
| `agent.mcp_consent.resolve` | `resolve_mcp_consent` | `agent.mcp_consent.resolve`, `agent.mcp.consent.resolve` | no |  |
| `agent.mcp.delete` | `delete_mcp_server` | `agent.mcp.delete` | no |  |
| `agent.mcp.list` | `list_mcp_servers` | `agent.mcp.list` | no |  |
| `agent.mcp.register` | `register_mcp_server` | `agent.mcp.register` | no |  |
| `agent.mcp.set_enabled` | `set_mcp_enabled` | `agent.mcp.set_enabled` | no |  |
| `agent.memory_citation.list` | `list_memory_citations` | `agent.memory_citation.list`, `agent.memory.citations.list` | no |  |
| `agent.memory_evidence.attach` | `attach_memory_evidence` | `agent.memory_evidence.attach`, `agent.memory.evidence.attach` | no |  |
| `agent.memory_import.commit` | `commit_memory_import` | `agent.memory_import.commit`, `agent.memory.import.commit` | no |  |
| `agent.memory_import.parse` | `parse_memory_import` | `agent.memory_import.parse`, `agent.memory.import.parse` | no |  |
| `agent.memory_policy.read` | `get_memory_policy` | `agent.memory_policy.read`, `agent.memory.policy.read` | no |  |
| `agent.memory_policy.write` | `update_memory_policy` | `agent.memory_policy.write`, `agent.memory.policy.write` | no |  |
| `agent.memory_promotion.list` | `list_memory_promotions` | `agent.memory_promotion.list`, `agent.memory.promotion.candidates` | no |  |
| `agent.memory.cite` | `cite_memory` | `agent.memory.cite` | no |  |
| `agent.memory.delete` | `delete_memory` | `agent.memory.delete` | no |  |
| `agent.memory.list` | `list_memories` | `agent.memory.list` | no |  |
| `agent.memory.promote` | `promote_memory` | `agent.memory.promote` | no |  |
| `agent.memory.recall` | `recall_memory` | `agent.memory.recall` | no |  |
| `agent.memory.remember` | `save_memory` | `agent.memory.remember` | no |  |
| `agent.memory.update` | `update_memory` | `agent.memory.update` | no |  |
| `agent.memory.write` | `write_memory` | `agent.memory.write` | no |  |
| `agent.plan.approve` | `approve_plan` | `agent.plan.approve` | no |  |
| `agent.plan.create` | `create_plan` | `agent.plan.create` | no |  |
| `agent.repo.edit` | `edit_repo_file` | `agent.repo.edit` | no |  |
| `agent.sandbox_file.list` | `list_sandbox_files` | `agent.sandbox_file.list`, `agent.sandbox.files.list` | no |  |
| `agent.sandbox_file.read` | `read_sandbox_file` | `agent.sandbox_file.read`, `agent.sandbox.files.read` | no |  |
| `agent.sandbox.exec` | `run_sandbox_command` | `agent.sandbox.exec` | no |  |
| `agent.sandbox.snapshot` | `snapshot_sandbox` | `agent.sandbox.snapshot` | no |  |
| `agent.sandbox.start` | `start_sandbox` | `agent.sandbox.start` | no |  |
| `agent.sandbox.stop` | `stop_sandbox` | `agent.sandbox.stop` | no |  |
| `agent.skill.list` | `list_agent_skills` | `agent.skill.list` | no |  |
| `agent.skill.load` | `load_skill` | `agent.skill.load` | no |  |
| `agent.subagent_fanout.get` | `get_subagent_fanout` | `agent.subagent_fanout.get`, `agent.subagent.fanout.get` | no |  |
| `agent.subagent_fanout.list` | `list_subagent_fanouts` | `agent.subagent_fanout.list`, `agent.subagent.fanout.list` | no |  |
| `agent.subagent_result.get` | `get_subagent_result` | `agent.subagent_result.get`, `agent.subagent.result.get` | no |  |
| `agent.subagent.aggregate` | `aggregate_subagents` | `agent.subagent.aggregate` | no |  |
| `agent.subagent.cancel` | `cancel_subagent` | `agent.subagent.cancel` | no |  |
| `agent.subagent.dispatch` | `dispatch_subagent` | `agent.subagent.dispatch` | no |  |
| `agent.subagent.logs` | `get_subagent_logs` | `agent.subagent.logs` | no |  |
| `agent.subagent.siblings` | `list_subagent_siblings` | `agent.subagent.siblings` | no |  |
| `agent.tool.list` | `list_agent_tools` | `agent.tool.list` | no |  |
| `agent.trace.get` | `get_execution_trace` | `agent.trace.get` | no |  |
| `agent.trigger.create` | `create_trigger` | `agent.trigger.create` | no |  |
| `agent.trigger.delete` | `delete_trigger` | `agent.trigger.delete` | no |  |
| `agent.trigger.list` | `list_triggers` | `agent.trigger.list` | no |  |
| `agent.trigger.update` | `update_trigger` | `agent.trigger.update` | no |  |
| `agent.ui.render` | `render_agent_ui` | `agent.ui.render` | no |  |
| `api.key.create` | `create_api_key` | `api.key.create` | no |  |
| `api.key.revoke` | `revoke_api_key` | `api.key.revoke` | no |  |
| `api.key.rotate` | `rotate_api_key` | `api.key.rotate` | no |  |
| `archive.create` | `create_archive` | `archive.create` | no |  |
| `asset.upload` | `upload_asset` | `asset.upload` | no |  |
| `audit.log.query` | `query_audit_log` | `audit.log.query` | no |  |
| `automation.create` | `create_automation` | `automation.create` | no |  |
| `automation.disable` | `disable_automation` | `automation.disable` | no |  |
| `automation.enable` | `enable_automation` | `automation.enable` | no |  |
| `automation.list` | `list_automations` | `automation.list` | no |  |
| `automation.trigger` | `trigger_automation` | `automation.trigger` | no |  |
| `automation.update` | `update_automation` | `automation.update` | no |  |
| `billing.credits.purchase` | `purchase_credits` | `billing.credits.purchase` | no |  |
| `billing.subscription_upgrade.start` | `start_subscription_upgrade` | `billing.subscription_upgrade.start`, `billing.subscription.upgrade.start` | no |  |
| `billing.subscription.read` | `get_subscription` | `billing.subscription.read` | no |  |
| `billing.usage.breakdown` | `get_usage_breakdown` | `billing.usage.breakdown` | no |  |
| `browser.click` | `click_page` | `browser.click` | no |  |
| `browser.fill` | `fill_page` | `browser.fill` | no |  |
| `browser.navigate` | `navigate_page` | `browser.navigate` | no |  |
| `browser.read` | `read_page` | `browser.read` | no |  |
| `browser.refresh` | `refresh_page` | `browser.refresh` | no |  |
| `browser.screenshot` | `screenshot_page` | `browser.screenshot` | no |  |
| `browser.submit` | `submit_page` | `browser.submit` | no |  |
| `budget.policy.read` | `get_user_budget` | `budget.policy.read` | no |  |
| `budget.policy.write` | `update_user_budget` | `budget.policy.write` | no |  |
| `chat.message.execution` | `get_message_execution` | `chat.message.execution` | no |  |
| `chat.message.send` | `send_message` | `chat.message.send` | no |  |
| `code.diff` | `diff_code` | `code.diff` | no |  |
| `code.format` | `format_code` | `code.format` | no |  |
| `code.map` | `get_code_map` | `code.map` | no |  |
| `code.patch` | `patch_code` | `code.patch` | no |  |
| `command.menu.search` | `search_command_menu` | `command.menu.search` | no |  |
| `command.menu.suggest` | `suggest_commands` | `command.menu.suggest` | no |  |
| `connection.create` | `create_connection` | `connection.create` | no |  |
| `connection.delete` | `delete_connection` | `connection.delete` | no |  |
| `connection.get` | `get_connection` | `connection.get` | no |  |
| `connection.list` | `list_connections` | `connection.list` | no |  |
| `connection.mappings.get` | `get_connection_mappings` | `connection.mappings.get` | no |  |
| `connection.mappings.set` | `set_connection_mappings` | `connection.mappings.set` | no |  |
| `connection.mappings.suggest` | `suggest_connection_mappings` | `connection.mappings.suggest` | no |  |
| `connection.pause` | `pause_connection` | `connection.pause` | no |  |
| `connection.preview` | `preview_connection` | `connection.preview` | no |  |
| `connection.update` | `update_connection` | `connection.update` | no |  |
| `conversation.archive` | `archive_conversation` | `conversation.archive` | no |  |
| `conversation.attachment.add` | `add_conversation_attachment` | `conversation.attachment.add` | no |  |
| `conversation.chat` | `post_conversation_message` | `conversation.chat` | no |  |
| `conversation.delete` | `delete_conversation` | `conversation.delete` | no |  |
| `conversation.export` | `export_conversation` | `conversation.export` | no |  |
| `conversation.files.list` | `list_conversation_files` | `conversation.files.list` | no |  |
| `conversation.list` | `list_conversations` | `conversation.list` | no |  |
| `conversation.purge` | `purge_conversations` | `conversation.purge` | no |  |
| `conversation.rename` | `rename_conversation` | `conversation.rename` | no |  |
| `document.create` | `create_document` | `document.create` | no |  |
| `document.generate` | `generate_document` | `document.generate`, `documents.generate` | no |  |
| `document.list` | `list_documents` | `document.list` | no |  |
| `document.pdf.create` | `create_pdf` | `document.pdf.create`, `documents.pdf.create` | no |  |
| `document.read` | `read_document` | `document.read` | no |  |
| `environment.create` | `create_environment` | `environment.create` | no |  |
| `environment.delete` | `delete_environment` | `environment.delete` | no |  |
| `environment.get` | `get_environment` | `environment.get` | no |  |
| `environment.list` | `list_environments` | `environment.list` | no |  |
| `environment.set_default` | `set_default_environment` | `environment.set_default` | no |  |
| `environment.update` | `update_environment` | `environment.update` | no |  |
| `eval.dataset_item.add` | `add_dataset_item` | `eval.dataset_item.add`, `eval.dataset.item.add` | no |  |
| `eval.dataset.create` | `create_dataset` | `eval.dataset.create` | no |  |
| `eval.dataset.from_traces` | `create_trace_dataset` | `eval.dataset.from_traces` | no |  |
| `eval.dataset.get` | `get_dataset` | `eval.dataset.get` | no |  |
| `eval.dataset.list` | `list_datasets` | `eval.dataset.list` | no |  |
| `eval.run.get` | `get_eval_run` | `eval.run.get` | no |  |
| `eval.run.start` | `start_eval_run` | `eval.run.start` | no |  |
| `eval.run.status` | `get_eval_status` | `eval.run.status` | no |  |
| `form.fill` | `fill_form` | `form.fill` | no |  |
| `graph.cypher` | `run_cypher` | `graph.cypher` | no |  |
| `graph.edge.delete` | `delete_edge` | `graph.edge.delete` | no |  |
| `graph.edge.upsert` | `upsert_edge` | `graph.edge.upsert` | no |  |
| `graph.export` | `export_graph` | `graph.export` | no |  |
| `graph.ingest` | `ingest_graph` | `graph.ingest` | no |  |
| `graph.node_label.add` | `add_node_label` | `graph.node_label.add`, `graph.node.label.add` | no |  |
| `graph.node_label.get` | `get_node_labels` | `graph.node_label.get`, `graph.node.labels.get` | no |  |
| `graph.node_label.remove` | `remove_node_label` | `graph.node_label.remove`, `graph.node.label.remove` | no |  |
| `graph.node.delete` | `delete_node` | `graph.node.delete` | no |  |
| `graph.node.get` | `get_node` | `graph.node.get` | no |  |
| `graph.node.list` | `list_nodes` | `graph.node.list` | no |  |
| `graph.node.search` | `search_nodes` | `graph.node.search` | no |  |
| `graph.node.upsert` | `upsert_node` | `graph.node.upsert` | no |  |
| `graph.relationship.upsert` | `upsert_graph_relationship` | `graph.relationship.upsert` | no |  |
| `graph.search` | `search_graph` | `graph.search` | no |  |
| `graph.stats` | `get_graph_stats` | `graph.stats` | no |  |
| `graph.sync.push` | `push_graph` | `graph.sync.push` | no |  |
| `image.analyze` | `analyze_image` | `image.analyze` | no |  |
| `image.create` | `create_image` | `image.create` | no |  |
| `image.generate` | `generate_image` | `image.generate` | no |  |
| `image.list` | `list_images` | `image.list` | no |  |
| `integration.configure` | `configure_integration` | `integration.configure` | no |  |
| `integration.delete` | `delete_integration` | `integration.delete` | no |  |
| `integration.get` | `get_integration` | `integration.get` | no |  |
| `integration.install` | `install_integration` | `integration.install` | no |  |
| `integration.list` | `list_integrations` | `integration.list` | no |  |
| `integration.metrics` | `get_integration_metrics` | `integration.metrics` | no |  |
| `integration.sync` | `sync_integration` | `integration.sync` | no |  |
| `markdown.generate` | `generate_markdown` | `markdown.generate` | no |  |
| `mermaid.generate` | `generate_mermaid` | `mermaid.generate` | no |  |
| `notification.list` | `list_notifications` | `notification.list`, `notifications.list` | no |  |
| `notification.mark` | `mark_notification` | `notification.mark`, `notifications.mark` | no |  |
| `ontology.neighbors` | `get_ontology_neighbors` | `ontology.neighbors` | no |  |
| `ontology.query` | `query_ontology` | `ontology.query` | no |  |
| `org.create` | `create_org` | `org.create`, `organization.create` | no |  |
| `org.list` | `list_orgs` | `org.list` | no |  |
| `org.member_invite.accept` | `accept_member_invite` | `org.member_invite.accept`, `org.member.invite.accept` | no |  |
| `org.member_invite.decline` | `decline_member_invite` | `org.member_invite.decline`, `org.member.invite.decline` | no |  |
| `org.member_role.change` | `change_member_role` | `org.member_role.change`, `org.member.role.change` | no |  |
| `org.member.add` | `add_org_member` | `org.member.add` | no |  |
| `org.member.remove` | `remove_org_member` | `org.member.remove` | no |  |
| `org.settings.read` | `get_org_settings` | `org.settings.read` | no |  |
| `org.settings.write` | `update_org_settings` | `org.settings.write` | no |  |
| `plugin.catalog.browse` | `browse_plugin_catalog` | `plugin.catalog.browse` | no |  |
| `plugin.catalog.get` | `get_catalog_plugin` | `plugin.catalog.get` | no |  |
| `plugin.catalog.sync` | `sync_plugin_catalog` | `plugin.catalog.sync` | no |  |
| `plugin.credential.reauth` | `reauth_plugin_credential` | `plugin.credential.reauth` | no |  |
| `plugin.credential.set_secret` | `set_plugin_secret` | `plugin.credential.set_secret` | no |  |
| `plugin.org.install` | `install_plugin` | `plugin.org.install` | no |  |
| `plugin.org.install_bulk` | `install_plugins_bulk` | `plugin.org.install_bulk` | no |  |
| `plugin.org.list` | `list_plugins` | `plugin.org.list` | no |  |
| `plugin.org.set_enabled` | `set_plugin_enabled` | `plugin.set_enabled` | merged | scope-collapse merge → `set_plugin_enabled(scope)` (EXECUTED) |
| `plugin.org.uninstall` | `uninstall_plugin` | `plugin.org.uninstall` | no |  |
| `plugin.registry.add` | `add_plugin_registry` | `plugin.registry.add` | no |  |
| `plugin.registry.list` | `list_plugin_registries` | `plugin.registry.list` | no |  |
| `plugin.registry.remove` | `remove_plugin_registry` | `plugin.registry.remove` | no |  |
| `plugin.schema.get` | `get_plugin_schema` | `plugin.schema.get` | no |  |
| `plugin.schema.validate` | `validate_plugin_schema` | `plugin.schema.validate` | no |  |
| `plugin.settings.set_auth_alerts` | `set_auth_alerts` | `plugin.settings.set_auth_alerts` | no |  |
| `plugin.version.list` | `list_plugin_versions` | `plugin.version.list` | no |  |
| `plugin.workspace.set_enabled` | `set_plugin_enabled` | `plugin.set_enabled` | merged | scope-collapse merge → `set_plugin_enabled(scope)` (EXECUTED); merged into the row above |
| `privacy.data.erase` | `erase_data` | `privacy.data.erase` | no |  |
| `privacy.data.export` | `export_data` | `privacy.data.export` | no |  |
| `prompt.settings.read` | `get_prompt_settings` | `prompt.settings.read` | no |  |
| `prompt.settings.write` | `update_prompt_settings` | `prompt.settings.write` | no |  |
| `repo.branch.create` | `create_branch` | `repo.branch.create` | no |  |
| `repo.ci.status` | `get_ci_status` | `repo.ci.status` | no |  |
| `repo.configure` | `configure_repo` | `repo.configure` | no |  |
| `repo.create` | `create_repo` | `repo.create` | no |  |
| `repo.file.put` | `put_repo_file` | `repo.file.put` | no |  |
| `repo.fork` | `fork_repo` | `repo.fork` | no |  |
| `repo.metrics` | `get_repo_metrics` | `repo.metrics` | no |  |
| `repo.pause` | `pause_repo` | `repo.pause` | no |  |
| `repo.pr.diff` | `get_pr_diff` | `repo.pr.diff` | no |  |
| `repo.pr.get` | `get_pr` | `repo.pr.get` | no |  |
| `repo.pr.open` | `open_pr` | `repo.pr.open` | no |  |
| `repo.resume` | `resume_repo` | `repo.resume` | no |  |
| `repo.sync` | `sync_repo` | `repo.sync` | no |  |
| `research.swarm.start` | `start_research_swarm` | `research.swarm.start` | no |  |
| `research.swarm.status` | `get_research_status` | `research.swarm.status` | no |  |
| `schema.chat` | `run_schema_chat` | `schema.chat` | no |  |
| `schema.delete` | `delete_schema` | `schema.delete` | no |  |
| `schema.export` | `export_schema` | `schema.export` | no |  |
| `schema.label.delete` | `delete_schema_label` | `schema.label.delete` | no |  |
| `schema.label.upsert` | `upsert_schema_label` | `schema.label.upsert` | no |  |
| `schema.list` | `list_schemas` | `schema.list` | no |  |
| `schema.property.delete` | `delete_schema_property` | `schema.property.delete` | no |  |
| `schema.property.upsert` | `upsert_schema_property` | `schema.property.upsert` | no |  |
| `schema.recommend` | `recommend_schema` | `schema.recommend` | no |  |
| `schema.reconcile.dispatch` | `dispatch_schema_reconcile` | `schema.reconcile.dispatch` | no |  |
| `schema.reconcile.status` | `get_reconcile_status` | `schema.reconcile.status` | no |  |
| `schema.registry.config` | `get_registry_config` | `schema.registry.config` | no |  |
| `schema.registry.get` | `get_schema_registry` | `schema.registry.get` | no |  |
| `schema.relationship.delete` | `delete_schema_relationship` | `schema.relationship.delete` | no |  |
| `schema.relationship.upsert` | `upsert_schema_relationship` | `schema.relationship.upsert` | no |  |
| `schema.setup` | `setup_schema` | `schema.setup` | no |  |
| `schema.toggle` | `toggle_schema` | `schema.toggle` | no |  |
| `schema.validate.node` | `validate_schema_node` | `schema.validate.node` | no |  |
| `schema.validate.relationship` | `validate_schema_relationship` | `schema.validate.relationship` | no |  |
| `schema.version.create` | `create_schema_version` | `schema.version.create` | no |  |
| `schema.version.diff` | `diff_schema_versions` | `schema.version.diff` | no |  |
| `schema.version.list` | `list_schema_versions` | `schema.version.list` | no |  |
| `schema.version.pin` | `pin_schema_version` | `schema.version.pin` | no |  |
| `secret.export` | `export_secrets` | `secret.export` | no |  |
| `secret.import_env` | `import_env_secrets` | `secret.import_env` | no |  |
| `secret.key.delete` | `delete_secret_key` | `secret.key.delete` | no |  |
| `secret.key.list` | `list_secret_keys` | `secret.key.list` | no |  |
| `secret.key.upsert` | `upsert_secret_key` | `secret.key.upsert` | no |  |
| `secret.reveal` | `reveal_secret` | `secret.reveal` | no |  |
| `secret.value.set` | `set_secret_value` | `secret.value.set` | no |  |
| `secret.value.unset` | `unset_secret_value` | `secret.value.unset` | no |  |
| `semantic.edge.approve` | `approve_semantic_edge` | `semantic.edge.approve` | no |  |
| `semantic.edge.infer` | `infer_semantic_edges` | `semantic.edge.infer` | no |  |
| `semantic.edge.list` | `list_semantic_edges` | `semantic.edge.list` | no |  |
| `semantic.edge.suggest` | `suggest_semantic_edges` | `semantic.edge.suggest` | no |  |
| `semantic.relationship.approve` | `approve_semantic_relationship` | `semantic.relationship.approve` | no |  |
| `semantic.relationship.infer` | `infer_semantic_relationships` | `semantic.relationship.infer` | no |  |
| `semantic.relationship.list` | `list_semantic_relationships` | `semantic.relationship.list` | no |  |
| `semantic.relationship.suggest` | `suggest_semantic_relationships` | `semantic.relationship.suggest` | no |  |
| `skill.author` | `author_skill` | `skill.author` | no |  |
| `skill.create` | `create_skill` | `skill.create` | no |  |
| `skill.draft` | `draft_skill` | `skill.draft` | no |  |
| `skill.edit` | `edit_skill` | `skill.edit` | no |  |
| `skill.enable` | `set_skill_enabled` | `skill.enable` | no |  |
| `skill.export` | `export_skill` | `skill.export` | no |  |
| `skill.metrics.read` | `get_skill_metrics` | `skill.metrics.read` | no |  |
| `skill.version.activate` | `activate_skill_version` | `skill.version.activate` | no |  |
| `skill.version.get` | `get_skill_version` | `skill.version.get` | no |  |
| `skill.version.list` | `list_skill_versions` | `skill.version.list` | no |  |
| `skill.version.upload` | `upload_skill_version` | `skill.version.upload` | no |  |
| `skill.workspace.install` | `install_skill` | `skill.workspace.install` | no |  |
| `skill.workspace.list` | `list_workspace_skills` | `skill.workspace.list` | no |  |
| `svg.generate` | `generate_svg` | `svg.generate` | no |  |
| `system.install.instructions` | `get_install_instructions` | `system.install.instructions` | no |  |
| `telemetry.error.cluster` | `list_error_clusters` | `telemetry.error.cluster` | no |  |
| `user.preferences.read` | `get_user_preferences` | `user.preferences.read` | no |  |
| `user.preferences.write` | `update_user_preferences` | `user.preferences.write` | no |  |
| `video.generate` | `generate_video` | `video.generate` | no |  |
| `web.fetch` | `fetch_web_page` | `web.fetch` | no |  |
| `web.search` | `search_web` | `web.search` | no |  |
| `workflow.cancel` | `cancel_workflow` | `workflow.cancel` | no |  |
| `workflow.run` | `run_workflow` | `workflow.run` | no |  |
| `workflow.status` | `get_workflow_status` | `workflow.status` | no |  |
| `workspace.budget_policy.read` | `get_budget_policy` | `workspace.budget_policy.read`, `workspace.budget.policy.read` | no |  |
| `workspace.budget_policy.write` | `update_budget_policy` | `workspace.budget_policy.write`, `workspace.budget.policy.write` | no |  |
| `workspace.create` | `create_workspace` | `workspace.create` | no |  |
| `workspace.invite.send` | `send_workspace_invite` | `workspace.invite.send` | no |  |
| `workspace.list` | `list_workspaces` | `workspace.list` | no |  |
| `workspace.member.list` | `list_workspace_members` | `workspace.member.list` | no |  |
| `workspace.model_settings.read` | `get_model_settings` | `workspace.model_settings.read`, `workspace.model.settings.read` | no |  |
| `workspace.model_settings.write` | `update_model_settings` | `workspace.model_settings.write`, `workspace.model.settings.write` | no |  |
| `workspace.settings.read` | `get_workspace_settings` | `workspace.settings.read` | no |  |
| `workspace.settings.write` | `update_workspace_settings` | `workspace.settings.write` | no |  |

## Deferred file-path realignment phase

The functional rename (contract `name` + `aliases`) is complete and self-consistent — the runtime dispatches by the contract object's `.name`, and IAM/metering resolve old dotted names via the alias index. The following **file/path** work is the remaining phase (it does not change behavior, only file names and the `check_manifest.mjs` file-path heuristic, which keys `apps/api/src/routes/v1/<name>.ts` and `apps/mcp/src/tools/<name>.ts` off the capability name):

1. `git mv` each of the 294 contract files `packages/oxagen/src/contracts/<old-dotted>.ts` → `<new-snake>.ts` (and its `.test.ts`), then rewrite `contracts/index.ts` and the ~895 dotted contract-import sites (`from ".../contracts/<old-dotted>"`). The `.model` helper files are NOT registered capabilities — leave them.
2. Rename the standalone api route files (`apps/api/src/routes/v1/<old-dotted>.ts`) and update their mounts in `apps/api/src/app.ts`. Combined route files (`connection.ts`, `schema.ts`, `repo.ts`, …) were already manifest false-positives and need no move.
3. Rename the mcp tool files (`apps/mcp/src/tools/<old-dotted>.ts`); xmcp auto-discovers by directory so only the file name changes.
4. Rename `docs/capabilities/<old-dotted>.md` → `<new-snake>.md` and update `docs/capabilities/_index.md`.
5. Regenerate `packages/oxagen/capabilities.manifest.json` (`node tools/scripts/check_manifest.mjs`) and confirm no new api/mcp gaps.

# Mission Control — traceability matrix

Every target tool in Appendix E, traced to the code it replaces, the screen that surfaces it,
the mockup function that draws it, the tables it touches, and the milestone that ships it.

Regenerate the mechanical columns with `tools/scripts/mission-control/build-full-matrix.mjs`.
The three judgment columns were assigned by five agents reading §14, §17 and Appendix A, then
audited adversarially by a sixth. **The matrix is generated; do not hand-edit it.**

| Column | Source | Mechanical? |
|---|---|---|
| Tool | Appendix E | yes — literal |
| Absorbs | joined on `registerCapability({name})` in `packages/oxagen/src/contracts/` | yes — literal |
| Screen | §14's ten screens and their primary actions | assigned + audited |
| Mockup fn | `mc.html`'s `render()` dispatch | yes — literal |
| Tables | Appendix A's 37 tables | assigned + audited |
| Milestone | §17 M0–M6 | assigned + audited |

## Where the work actually is

| Grade | Meaning | Count |
|---|---|---|
| `INHERIT` | every absorbed contract resolves; schema, risk grade and default effect carry forward | 74 |
| `MERGE` | some absorbed contracts resolve, some do not | 0 |
| `NEW` | nothing resolves; genuine design work | 22 |

### By milestone

| Milestone | Delivers | Tools | of which `NEW` |
|---|---|---|---|
| **M0** Foundations |  the repo, the kernel, tenancy, rls (row-level security) with role-based system access, or… | 26 | 1 |
| **M1** Gateway |  the model proxy. the tool gateway with schema validation (each tool call is checked again… | 17 | 2 |
| **M2** Control |  bundles, commands, approvals with tokens, and budgets. the full call pipeline with taint … | 24 | 14 |
| **M3** Teach |  the records endpoint, the reflector, the promoter, context prs through the github app, st… | 12 | 1 |
| **M4** Ground |  the ontology engine and three connectors. github events and issue import. the code graph … | 11 | 0 |
| **M5** Audit |  the archiver, compaction, holds, erasure, and reconciliation against a real provider invo… | 6 | 4 |
| **M6** Prove |  the witness runner. the witness author, with the test-flip and build oracles first. the a… | 0 | 0 |

### By screen

| Screen | Job (§14) | Tools |
|---|---|---|
| **Fleet** | Every run, live and recent, with its enforcement tier, replay grade, cost so far… | 9 |
| **Run** | A frame-by-frame player for one run. It shows the transcript at three zoom level… | 10 |
| **Agents** | Each agent's identity, run credential, roles, its toolbelt (the tools it may cal… | 27 |
| **Tools** | The registry (servers, tools, versions, schemas, safety classification), approva… | 21 |
| **Ontology** | The workspace's model of its own business, and the page the product is known for… | 15 |
| **Steering** | Published records, proposals, open Context PRs, effect metrics, and retirement c… | 11 |
| **Spend** | Findings ranked by the money at stake. Cost by operator, agent, model, provider … | 8 |
| **Organization** | People, roles, invitations, SSO (single sign-on), workspaces, model funding and … | 24 |
| **Billing** | Governed-action usage, the retention meter, plan, and invoices… | 4 |
| **Audit** | Control-plane audit events, data plane, key rotation, legal holds, and exports… | 11 |
| sign-in flow (not a page) | *(not a §14 page)* | 1 |
| headless | *(not a §14 page)* | 2 |


## Organization and workspace

| Tool | Grade | Absorbs | Screen | Mockup fn | Tables | M |
|---|---|---|---|---|---|---|
| `create_org` | INHERIT | `org.create.ts` | Organization | `pOrganization`:6003 | `org.organizations` `org.org_users` `org.data_planes` `iam.principals` `iam.roles` `billing.subscriptions` `audit.audit_events` | M0 |
| `update_org` | INHERIT | `org.settings.write.ts` | Organization | `pOrganization`:6003 | `org.organizations` `audit.audit_events` | M0 |
| `invite_member` | INHERIT | `workspace.invite.send.ts`<br>`org.member.add.ts` | Organization | `pOrganization`:6003 | `org.org_users` `wrk.workspace_users` `audit.audit_events` | M0 |
| `respond_to_invite` | INHERIT | `org.member_invite.accept.ts`<br>`org.member_invite.decline.ts` | sign-in flow (not a page) ⚑ | `pOrganization`:6003 | `org.org_users` `wrk.workspace_users` `iam.principals` `audit.audit_events` | M0 |
| `set_member_role` | INHERIT | `org.member_role.change.ts`<br>`org.member.remove.ts` | Organization | `pOrganization`:6003 | `org.org_users` `wrk.workspace_users` `iam.roles` `iam.principal_role_assignments` `audit.audit_events` | M0 |
| `list_members` | INHERIT | `workspace.member.list.ts` | Organization | `pOrganization`:6003 | `org.org_users` `wrk.workspace_users` `auth.users` `iam.roles` `iam.principal_role_assignments` | M0 |
| `create_workspace` | INHERIT | `workspace.create.ts`<br>`repo.configure.ts` | Organization | `pOrganization`:6003 | `wrk.workspaces` `wrk.workspace_users` `wrk.repositories` `audit.audit_events` | M0 |
| `update_workspace` | INHERIT | `workspace.settings.write.ts`<br>`agent.memory_policy.write.ts`<br>`workspace.budget_policy.write.ts`<br>`router.policy.set.ts` | Organization, Spend | `pOrganization`:6003 | `wrk.workspaces` `billing.budgets` `audit.audit_events` | M0 |
| `list_workspaces` | INHERIT | `workspace.list.ts`<br>`org.list.ts` | Organization | `pOrganization`:6003 | `wrk.workspaces` `wrk.workspace_users` `org.organizations` `org.org_users` | M0 |
| `get_data_plane` | INHERIT | `org.data_plane.get.ts` | Organization, Audit | `pOrganization`:6003 | `org.data_planes` | M0 |
| `set_data_plane` | INHERIT | `org.data_plane.set.ts` | Organization ⚑ | `pOrganization`:6003 | `org.data_planes` `control.approvals` `audit.audit_events` | M2 |


## Identity and access

| Tool | Grade | Absorbs | Screen | Mockup fn | Tables | M |
|---|---|---|---|---|---|---|
| `create_api_key` | INHERIT | `api.key.create.ts` | Organization, Agents | `pOrganization`:6003<br>`pAgents`:4875<br>`pAgent`:4921<br>`pMandate`:5072<br>`pAgentSource`:2980 | `iam.credentials` `iam.principals` `audit.audit_events` | M0 |
| `rotate_api_key` | INHERIT | `api.key.rotate.ts` | Organization, Agents | `pOrganization`:6003<br>`pAgents`:4875<br>`pAgent`:4921<br>`pMandate`:5072<br>`pAgentSource`:2980 | `iam.credentials` `audit.audit_events` | M0 |
| `revoke_api_key` | INHERIT | `api.key.revoke.ts` | Organization, Agents | `pOrganization`:6003<br>`pAgents`:4875<br>`pAgent`:4921<br>`pMandate`:5072<br>`pAgentSource`:2980 | `iam.credentials` `audit.audit_events` | M0 |
| `register_agent` | INHERIT | `agent.definition.create.ts`<br>`agent.definition.suggest.ts`<br>`agent.definition.summarize.ts` | Agents ⚑ | `pOrganization`:6003<br>`pAgents`:4875<br>`pAgent`:4921<br>`pMandate`:5072<br>`pAgentSource`:2980 | `iam.principals` `iam.role_grants` `iam.principal_role_assignments` `wrk.repositories` `audit.audit_events` | M3 |
| `update_agent` | INHERIT | `agent.definition.update.ts`<br>`agent.definition.revise.ts`<br>`agent.definition.publish.ts`<br>`agent.deploy.ts` | Agents ⚑ | `pOrganization`:6003<br>`pAgents`:4875<br>`pAgent`:4921<br>`pMandate`:5072<br>`pAgentSource`:2980 | `iam.principals` `iam.role_grants` `iam.principal_role_assignments` `wrk.repositories` `audit.audit_events` | M3 |
| `retire_agent` | INHERIT | `agent.definition.delete.ts` | Agents ⚑ | `pOrganization`:6003<br>`pAgents`:4875<br>`pAgent`:4921<br>`pMandate`:5072<br>`pAgentSource`:2980 | `iam.principals` `iam.principal_role_assignments` `iam.credentials` `audit.audit_events` | M3 |
| `get_agent` | INHERIT | `agent.definition.get.ts`<br>`agent.role.get.ts` | Agents | `pOrganization`:6003<br>`pAgents`:4875<br>`pAgent`:4921<br>`pMandate`:5072<br>`pAgentSource`:2980 | `iam.principals` `iam.roles` `iam.role_grants` `iam.principal_role_assignments` `iam.credentials` `tools.tool_versions` `tools.mandates` | M0 |
| `list_agents` | INHERIT | `agent.definition.list.ts` | Agents | `pOrganization`:6003<br>`pAgents`:4875<br>`pAgent`:4921<br>`pMandate`:5072<br>`pAgentSource`:2980 | `iam.principals` | M0 |
| `set_agent_role` | INHERIT | `agent.role.assign.ts`<br>`agent.role.revoke.ts` | Agents | `pOrganization`:6003<br>`pAgents`:4875<br>`pAgent`:4921<br>`pMandate`:5072<br>`pAgentSource`:2980 | `iam.roles` `iam.principal_role_assignments` `audit.audit_events` | M0 |
| `set_role_grants` | NEW | — *new* | Organization, Agents, Tools | `pOrganization`:6003<br>`pAgents`:4875<br>`pAgent`:4921<br>`pMandate`:5072<br>`pAgentSource`:2980 | `iam.roles` `iam.role_grants` `wrk.workspaces` `audit.audit_events` | M0 |


## Wrapping and control

| Tool | Grade | Absorbs | Screen | Mockup fn | Tables | M |
|---|---|---|---|---|---|---|
| `enroll_host` | INHERIT | `tacho.enrollment.create.ts` | Agents | `pFleet`:3351<br>`pRun`:3595 | `control.enrollments` `iam.principals` `iam.credentials` `audit.audit_events` | M1 |
| `revoke_enrollment` | INHERIT | `tacho.enrollment.revoke.ts` | Agents | `pFleet`:3351<br>`pRun`:3595 | `control.enrollments` `iam.credentials` `audit.audit_events` `wrk.workspaces` | M1 |
| `list_hosts` | INHERIT | `tacho.host.list.ts` | Agents | `pFleet`:3351<br>`pRun`:3595 | `control.enrollments` `iam.principals` | M1 |
| `get_policy_bundle` | INHERIT | `tacho.bundle.get.ts`<br>`schema.registry.config.ts` | Agents, Tools | `pFleet`:3351<br>`pRun`:3595 | `tools.policy_versions` `tools.tool_versions` `iam.role_grants` `tools.mandates` `billing.budgets` `wrk.workspaces` `org.organizations` `control.enrollments` | M2 |
| `ingest_frames` | INHERIT | `tacho.events.ingest.ts`<br>`agent.execution.record.ts`<br>`telemetry.stella.ingest.ts`<br>`agent.debug.trace.ts` | headless | `pFleet`:3351<br>`pRun`:3595 | `control.enrollments` `control.commands` `audit.audit_events` `cost.run_totals` `audit.archive_segments` | M1 |
| `fetch_commands` | INHERIT | `tacho.command.fetch.ts` | headless | `pFleet`:3351<br>`pRun`:3595 | `control.commands` `control.enrollments` | M1 |
| `dispatch_command` | INHERIT | `tacho.command.dispatch.ts` | Fleet, Run, Agents | `pFleet`:3351<br>`pRun`:3595 | `control.commands` | M1 |
| `list_runs` | INHERIT | `agent.execution.list.ts`<br>`tacho.session.list.ts` | Fleet, Agents | `pFleet`:3351<br>`pRun`:3595 | `cost.run_totals` | M1 |
| `get_run` | INHERIT | `tacho.session.get.ts`<br>`agent.trace.get.ts`<br>`chat.message.execution.ts` | Run, Fleet | `pFleet`:3351<br>`pRun`:3595 | `cost.run_totals` `control.tool_calls` `control.approvals` `control.commands` `audit.archive_segments` | M1 |
| `export_run` | NEW | — *new* | Run, Audit | `pFleet`:3351<br>`pRun`:3595 | `audit.archive_segments` `audit.audit_events` `cost.run_totals` | M1 |
| `list_approvals` | NEW | — *new* | Fleet, Run ⚑ | `pFleet`:3351<br>`pRun`:3595 | `control.approvals` `control.tool_calls` `iam.principals` | M2 |
| `resolve_approval` | INHERIT | `agent.approval.resolve.ts`<br>`agent.mcp_consent.resolve.ts` | Fleet, Run ⚑ | `pFleet`:3351<br>`pRun`:3595 | `control.approvals` `control.tool_calls` | M2 |
| `send_message` | NEW | — *new* | Fleet, Run ? | `pFleet`:3351<br>`pRun`:3595 | `control.commands` | M2 |
| `list_messages` | NEW | — *new* | Fleet, Run ? | `pFleet`:3351<br>`pRun`:3595 | `control.commands` | M2 |


## Toolbelt

| Tool | Grade | Absorbs | Screen | Mockup fn | Tables | M |
|---|---|---|---|---|---|---|
| `register_tool_server` | INHERIT | `agent.mcp.register.ts`<br>`agent.mcp.set_enabled.ts` | Tools | `pTools`:5122 | `tools.tool_servers` `tools.connections` | M0 |
| `remove_tool_server` | INHERIT | `agent.mcp.delete.ts` | Tools | `pTools`:5122 | `tools.tool_servers` `tools.tool_versions` | M0 |
| `list_tool_servers` | INHERIT | `agent.mcp.list.ts`<br>`agent.mcp.resolve.ts`<br>`agent.mcp_consent.list.ts` | Tools | `pTools`:5122 | `tools.tool_servers` `tools.tool_versions` | M0 |
| `import_tools` | INHERIT | `tool.declaration.list.ts`<br>`tool.declaration.publish.ts`<br>`agent.tool.list.ts` | Tools | `pTools`:5122 | `tools.tool_versions` `tools.tool_servers` | M0 |
| `approve_tool_schema` | NEW | — *new* | Tools | `pTools`:5122 | `tools.tool_versions` | M2 |
| `search_tools` | INHERIT | `command.menu.search.ts`<br>`command.menu.suggest.ts` | Tools | `pTools`:5122 | `tools.tool_versions` `iam.role_grants` | M2 |
| `load_tools` | NEW | — *new* | Tools, Agents | `pTools`:5122 | `tools.tool_versions` | M2 |
| `set_connection` | INHERIT | `org.model_credential.set.ts`<br>`org.model_credential.verify.ts`<br>`secret.key.upsert.ts`<br>`secret.value.set.ts`<br>`plugin.credential.set_secret.ts`<br>`plugin.credential.reauth.ts` | Tools, Organization | `pTools`:5122 | `tools.connections` | M1 |
| `delete_connection` | INHERIT | `connection.delete.ts`<br>`org.model_credential.delete.ts`<br>`secret.key.delete.ts`<br>`secret.value.unset.ts`<br>`plugin.credential.revoke.ts` | Tools, Organization | `pTools`:5122 | `tools.connections` `tools.credential_grants` | M1 |
| `list_connections` | INHERIT | `connection.list.ts`<br>`secret.key.list.ts`<br>`org.model_credential.get.ts` | Tools, Organization | `pTools`:5122 | `tools.connections` `tools.credential_grants` | M1 |
| `grant_mandate` | NEW | — *new* | Tools, Agents | `pTools`:5122 | `tools.mandates` `tools.mandate_ledger` | M2 |
| `set_approval_rules` | NEW | — *new* | Tools | `pTools`:5122 | `tools.policy_versions` | M2 |
| `revoke_mandate` | NEW | — *new* | Tools, Agents | `pTools`:5122 | `tools.mandates` `tools.mandate_ledger` | M2 |
| `list_mandates` | NEW | — *new* | Tools, Agents | `pTools`:5122 | `tools.mandates` `tools.mandate_ledger` | M2 |
| `set_policy` | NEW | — *new* | Tools | `pTools`:5122 | `tools.policy_versions` `wrk.workspaces` | M2 |
| `simulate_policy` | NEW | — *new* | Tools | `pTools`:5122 | `tools.policy_versions` | M2 |
| `set_kill_switch` | NEW | — *new* | Tools | `pTools`:5122 | `control.commands` `audit.audit_events` `org.organizations` `wrk.workspaces` `tools.tool_versions` `tools.tool_servers` `tools.connections` | M2 |


## Ontology and knowledge

| Tool | Grade | Absorbs | Screen | Mockup fn | Tables | M |
|---|---|---|---|---|---|---|
| `link_repository` | INHERIT | `repo.configure.ts`<br>`repo.sync.ts` | Ontology | `pOntology`:5306 | `wrk.repositories` `tools.connections` | M0 |
| `unlink_repository` | INHERIT | `repo.pause.ts`<br>`integration.delete.ts` | Ontology | `pOntology`:5306 | `wrk.repositories` `tools.connections` | M0 |
| `sync_repository` | INHERIT | `repo.sync.ts`<br>`repo.resume.ts`<br>`integration.sync.ts` | Ontology | `pOntology`:5306 | `wrk.repositories` | M4 |
| `add_source` | INHERIT | `plugin.org.install.ts`<br>`integration.configure.ts` | Ontology | `pOntology`:5306 | `tools.connections` `tools.tool_servers` | M4 |
| `update_source` | INHERIT | `connection.update.ts`<br>`connection.mappings.set.ts`<br>`connection.mappings.suggest.ts`<br>`connection.pause.ts`<br>`connection.preview.ts` | Ontology | `pOntology`:5306 | `tools.tool_servers` `tools.connections` | M4 |
| `remove_source` | INHERIT | `connection.delete.ts`<br>`plugin.org.uninstall.ts` | Ontology | `pOntology`:5306 | `tools.tool_servers` `tools.connections` | M4 |
| `list_sources` | INHERIT | `connection.list.ts`<br>`integration.list.ts`<br>`plugin.org.list.ts`<br>`integration.get.ts`<br>`integration.metrics.ts`<br>`schema.reconcile.status.ts` | Ontology | `pOntology`:5306 | `tools.tool_servers` `tools.connections` `wrk.repositories` | M4 |
| `propose_ontology_version` | INHERIT | `schema.recommend.ts`<br>`schema.setup.ts`<br>`schema.version.create.ts`<br>`schema.chat.ts`<br>`schema.version.pin.ts`<br>`schema.toggle.ts`<br>`schema.reconcile.dispatch.ts` | Ontology | `pOntology`:5306 | `wrk.repositories` | M4 |
| `get_ontology` | INHERIT | `schema.registry.get.ts`<br>`schema.version.list.ts`<br>`schema.list.ts`<br>`schema.version.diff.ts`<br>`schema.export.ts`<br>`graph.node_label.get.ts` | Ontology | `pOntology`:5306 | `wrk.workspaces` | M4 |
| `update_ontology` | INHERIT | `schema.label.upsert.ts`<br>`schema.property.upsert.ts`<br>`schema.relationship.upsert.ts`<br>`schema.label.delete.ts`<br>`schema.property.delete.ts`<br>`schema.relationship.delete.ts`<br>`schema.validate.node.ts`<br>`schema.validate.relationship.ts` | Ontology ? | `pOntology`:5306 | `wrk.repositories` | M4 |
| `search_graph` | INHERIT | `graph.search.ts`<br>`graph.node.search.ts`<br>`reference.search.ts`<br>`graph.node.list.ts` | Ontology | `pOntology`:5306 | — | M4 |
| `expand_graph` | INHERIT | `ontology.neighbors.ts`<br>`graph.node.get.ts` | Ontology | `pOntology`:5306 | — | M4 |
| `query_graph` | INHERIT | `ontology.query.ts`<br>`graph.stats.ts` | Ontology | `pOntology`:5306 | — | M4 |


## Context and steering

| Tool | Grade | Absorbs | Screen | Mockup fn | Tables | M |
|---|---|---|---|---|---|---|
| `append_record` | INHERIT | `agent.memory.write.ts`<br>`agent.memory.remember.ts`<br>`agent.memory_evidence.attach.ts`<br>`agent.memory.cite.ts`<br>`reference.cite.ts` | Steering | `pSteering`:5499 | — | M3 |
| `get_record` | NEW | — *new* | Steering | `pSteering`:5499 | — | M3 |
| `list_records` | INHERIT | `context.record.list.ts`<br>`agent.memory.list.ts`<br>`agent.memory_citation.list.ts`<br>`agent.memory_citation.stats.ts` | Steering | `pSteering`:5499 | — | M3 |
| `retract_record` | INHERIT | `agent.memory.delete.ts`<br>`agent.memory.demote.ts` | Steering | `pSteering`:5499 | — | M3 |
| `recall_context` | INHERIT | `agent.memory.recall.ts` | Steering, Run | `pSteering`:5499 | — | M3 |
| `propose_record` | INHERIT | `agent.memory.promote.ts`<br>`context.record.promote.ts`<br>`agent.memory_promotion.rationales.ts` | Steering | `pSteering`:5499 | — | M3 |
| `open_context_pr` | INHERIT | `context.record.publish.ts` | Steering | `pSteering`:5499 | `wrk.repositories` `wrk.workspaces` `audit.audit_events` | M3 |
| `list_proposals` | INHERIT | `agent.memory_promotion.list.ts` | Steering | `pSteering`:5499 | — | M3 |
| `dismiss_proposal` | INHERIT | `agent.memory_promotion.dismiss.ts` | Steering | `pSteering`:5499 | — | M3 |


## Spend and billing

| Tool | Grade | Absorbs | Screen | Mockup fn | Tables | M |
|---|---|---|---|---|---|---|
| `get_spend` | INHERIT | `billing.usage.breakdown.ts`<br>`router.stats.list.ts`<br>`repo.metrics.ts` | Spend, Agents | `pSpend`:5615<br>`pBilling`:6132 | `cost.run_totals` `billing.budgets` | M2 |
| `list_findings` | INHERIT | `telemetry.error.cluster.ts` | Spend, Agents | `pSpend`:5615<br>`pBilling`:6132 | `cost.run_totals` | M2 |
| `get_reconciliation` | NEW | — *new* | Spend | `pSpend`:5615<br>`pBilling`:6132 | `cost.reconciliations` `cost.provider_usage` `cost.run_totals` | M5 |
| `export_statement` | NEW | — *new* | Spend | `pSpend`:5615<br>`pBilling`:6132 | `cost.run_totals` `cost.reconciliations` | M2 |
| `set_budget` | INHERIT | `billing.budget.set.ts`<br>`billing.budget.get.ts`<br>`budget.policy.write.ts`<br>`budget.policy.read.ts`<br>`workspace.budget_policy.read.ts` | Spend, Agents | `pSpend`:5615<br>`pBilling`:6132 | `billing.budgets` | M2 |
| `set_model_route` | INHERIT | `workspace.model_settings.write.ts`<br>`workspace.model_settings.read.ts`<br>`router.decision.preview.ts`<br>`router.policy.get.ts` | Organization | `pSpend`:5615<br>`pBilling`:6132 | `org.organizations` | M1 |
| `set_funding_source` | NEW | — *new* | Organization | `pSpend`:5615<br>`pBilling`:6132 | `org.organizations` `tools.connections` | M1 |
| `get_subscription` | INHERIT | `billing.subscription.read.ts` | Billing ? | `pSpend`:5615<br>`pBilling`:6132 | `billing.subscriptions` `org.organizations` | M0 |
| `change_subscription` | INHERIT | `billing.subscription_upgrade.start.ts`<br>`billing.credits.purchase.ts` | Billing ? | `pSpend`:5615<br>`pBilling`:6132 | `billing.subscriptions` `org.organizations` | M0 |


## Audit and compliance

| Tool | Grade | Absorbs | Screen | Mockup fn | Tables | M |
|---|---|---|---|---|---|---|
| `query_audit_log` | INHERIT | `audit.log.query.ts`<br>`plugin.settings.get_auth_alerts.ts` | Audit | `pAudit`:6515 | `audit.audit_events` `control.tool_calls` `control.approvals` | M2 |
| `export_data` | INHERIT | `privacy.data.export.ts` | Audit | `pAudit`:6515 | `audit.archive_segments` `audit.audit_events` `org.organizations` | M5 |
| `erase_data` | INHERIT | `privacy.data.erase.ts` | Audit | `pAudit`:6515 | `audit.archive_segments` `audit.legal_holds` `audit.audit_events` | M5 |
| `set_legal_hold` | NEW | — *new* | Audit | `pAudit`:6515 | `audit.legal_holds` `audit.archive_segments` `audit.audit_events` | M5 |
| `list_incidents` | NEW | — *new* | Audit, Agents | `pAudit`:6515 | `audit.audit_events` | M2 |
| `set_event_subscription` | NEW | — *new* | Audit ? | `pAudit`:6515 | `control.event_subscriptions` `audit.audit_events` | M5 |
| `list_event_subscriptions` | NEW | — *new* | Audit ? | `pAudit`:6515 | `control.event_subscriptions` | M5 |


## Assistant and account

| Tool | Grade | Absorbs | Screen | Mockup fn | Tables | M |
|---|---|---|---|---|---|---|
| `ask_assistant` | INHERIT | `chat.message.send.ts`<br>`conversation.chat.ts`<br>`conversation.attachment.add.ts` | Fleet, Run, Agents, Tools, Ontology, Steering, Spend, Organization, Billing, Audit | `pOrganization`:6003 | `org.organizations` | M1 |
| `list_conversations` | INHERIT | `conversation.list.ts`<br>`conversation.rename.ts`<br>`conversation.archive.ts`<br>`conversation.delete.ts`<br>`conversation.export.ts`<br>`conversation.purge.ts`<br>`conversation.files.list.ts` | Fleet, Run, Agents, Tools, Ontology, Steering, Spend, Organization, Billing, Audit | `pOrganization`:6003 | — | M1 |
| `set_preferences` | INHERIT | `user.preferences.write.ts`<br>`user.preferences.read.ts`<br>`user.workspace_preferences.write.ts`<br>`user.workspace_preferences.read.ts`<br>`plugin.settings.set_auth_alerts.ts` | Organization ? | `pOrganization`:6003 | — | M0 |
| `list_notifications` | INHERIT | `notification.list.ts` | Organization ? | `pOrganization`:6003 | `audit.audit_events` `control.approvals` | M2 |
| `mark_notification` | INHERIT | `notification.mark.ts` | Organization ? | `pOrganization`:6003 | `audit.audit_events` | M2 |
| `get_install_instructions` | INHERIT | `system.install.instructions.ts` | Agents | `pOrganization`:6003 | — | M1 |


⚑ = changed by the audit. ? = the assigning agent marked it low confidence.

---

## Audit

> Strong work with a small number of hard errors and one systemic weakness. Table hygiene is excellent — zero invented names across 96 rows, and roughly a dozen of the proposal's keyword-collision tables were correctly overturned with the section that settles each. Milestone reasoning is mostly better than the matrix it audits, and the overturns (link_repository to M0, the M1 run tools, the M2 spend tools, the M5 audit tools) are defensible from §17's acceptance tests. Seven corrections stand: three tools name "Approvals" as a screen when §14 states in its first paragraph that Approvals is not a page, and does so in rows graded high that quote that very sentence in their own notes; the three agent-definition tools sit at M0 when §6.2 makes them Context-PR-first and §17 dates Context PRs to M3, a dependency each note identifies and then ignores; and respond_to_invite borrows Appendix E's reserved "headless" marking, which belongs to ingest_frames and fetch_commands alone. The systemic weakness is not the assignments' fault and should be read as a spec finding: M6 has no tool because none exists, five §14 primary actions and the assurance suite have no tool at all, five of the ten pages are delivered by no milestone, eight table names in the prose violate A.0's own "a table not here does not exist", and Appendix E's count of new tools is off by two with the wrong families named. Checked: all 96 table lists against the 37; all screen values against the 10 and against each screen's §14 job and primary actions; every milestone against §17's Delivers and Accepted-when columns and §17.1's phases; both coverage directions; and the "high" confidence rows against the sections cited.

**7 corrections applied.**

| Tool | Field | From | To | Why |
|---|---|---|---|---|
| `list_approvals` | screens | Approvals | Fleet, Run | §14 opening: "Approvals are not a page of their own. They appear as a panel on Fleet and as a strip on Run." "Approvals" is not one of the ten SCREENS, so the value is unusable in the matrix. Appendix F row 1 gives Fleet "the approvals queue as a panel" and row 2 gives Run "approvals on this run". The row's own note says exactly this and then writes the wrong value anyway — and grades itself high. |
| `resolve_approval` | screens | Approvals | Fleet, Run | Same §14 rule. Additionally §14's Run row lists "approve" among Run's own primary actions, which settles Run directly rather than by inheritance from the panel. |
| `set_data_plane` | screens | Organization, Approvals | Organization | §14: Approvals is not a page. §14 Organization's job names "the data plane"; §14 Audit's job names it too but Audit's primary actions are only export/hold/rotate, so the write belongs to Organization. If the approval-gate surface is wanted it is the Fleet panel / Run strip, never a screen named Approvals. |
| `register_agent` | milestone | M0 | M3 | §6.2 is unconditional: "Creating or changing an agent in Mission Control (register_agent, update_agent) does not write Postgres first. It opens a Context PR on the main repo… Merge creates or updates the principal, the roles the definition asks for, and the toolbelt." §17 dates Context-PR delivery to M3 ("Context PRs through the GitHub App"); M0 delivers only "IAM" and M0/M1 have the App installation for repo binding, not PR authoring. The tool as specified cannot execute before M3. The row's own note names this dependency and still assigns M0. |
| `update_agent` | milestone | M0 | M3 | Same §6.2 mechanism ("a Context PR changing the definition; identity and belt update on merge", Appendix E) and the same §17 M3 dependency on Context PRs through the GitHub App. |
| `retire_agent` | milestone | M0 | M3 | Appendix E: "a Context PR removing the file; principal retired, never deleted". §6.2: "Deleting an agent is a PR that removes the file." Same M3 dependency as its two siblings. |
| `respond_to_invite` | screens | headless | (none — sign-in flow, not a page) | Appendix E marks exactly two tools headless — ingest_frames and fetch_commands — and states every other tool "is exposed on API, MCP, and the UI unless marked headless". Appendix F settles the surface instead: "accept an invite" is one of the seven sign-in flows that "are not screens and are not counted". The honest value is no screen with that citation, not the reserved word headless. |

### Structural gaps the audit found (13)

- M6 has zero tools out of 96, and the fault is not the assignment — no Appendix E row is M6-first. §17 M6 delivers the witness runner, the witness author, the L0 airlock, tamper exclusion, proof stamping and "proven spend in the Spend page": backend services plus fields on tools that already exist (get_run renders §8.5's proof.observed frame, get_spend adds proven spend, list_incidents starts seeing witness_probe/tampered). §8.5 invariant 2 forbids an agent tool from ever addressing witness storage ("A tool call whose target resolves to witness storage is denied by policy and raises a witness_probe incident"), so no agent-facing witness tool can exist by design. What Appendix E genuinely lacks is the human-facing half: nothing sets the disclosure grain, though §8.5 says "A workspace may raise the grain as an explicit policy decision by a human, recorded as a security event", and nothing declares which classes of change require proof. Both could ride set_policy (M2, Tools). The deeper defect is the matrix's single-valued milestone column: it cannot express "ships at M1, completed at M6", which is the true state of get_run, get_spend and list_incidents.
- Five of the 37 tables are touched by no tool. Three are expected: auth.sessions, auth.accounts and auth.verifications are Better Auth's own (A.1: "platform scope, Better Auth's own tables, unchanged") and auth.users is correctly read only by list_members. Two are real gaps. cost.price_entries has no tool despite §12.2's "Organizations may override prices to record negotiated rates" — a customer-visible write with no contract, on the page (§14 Spend, "Every number that is money shows its basis") that depends on it; §17 M2 delivers "the price book" with nothing to administer it. cost.fx_rates has no importer or reader (§15 Currency: "Conversions use a dated rate table (cost.fx_rates)"); defensible as a platform job, but then it is a table no product surface reaches.
- Five §14 primary actions have no tool in Appendix E at all. Audit's "rotate" (§14 Audit job: "key rotation"; the key is org.organizations.kek_key_id, and §13.3 lists "key rotations" as a control-plane audit kind) — rotate_api_key is iam.credentials and explicitly is not this. Ontology's "resolve entity" and "upgrade an embedding index" (§11.5's indexes with recall and citation rate are rendered on the page with no tool behind either action). Run's "fork replay" and "bisect" (§17.1 defers them to Series A, but deferral is not a row, and Appendix E closes with "Nothing is added back without a row in this appendix"). Each is a screen action the matrix can never trace.
- §14 Tools' job ends "and the last result from the assurance suite", and Appendix F gives the Audit page "assurance suite results" — §6.13 makes the adversarial suite a shipped, customer-runnable artifact and part of the export an auditor receives. No tool in the 96 runs it or reads its result. Two screens render something nothing produces.
- §17 delivers only four of the ten pages by name: Fleet and Run at M1, the Tools page and the Spend page at M2, the Ontology page in §17.1's wedge list. Agents, Steering, Organization, Billing and Audit are never delivered by any milestone. This is the root cause of the largest milestone disagreement in the matrix: 29 tools landed at M0, a milestone whose Delivers row contains no UI whatsoever, because the Organization and Agents pages have no milestone to land on. Billing is worse — §17 never names billing or Stripe in any milestone, which both subscription rows correctly flagged as unassignable.
- Eight table names appear in the spec's own prose that are not among the 37, against A.0's "This is the definitive list. A table not here does not exist": tools.tools (§6.4), approvals.requests (§7.5), prices.price_books and prices.price_entries (§12.2, vs Appendix A's cost.price_entries), billing.spend_budgets (§12.5, vs billing.budgets), cost.turn_totals and cost.daily_totals (§12.3, §12.7), and cost.findings (§12.8). Every one of them forced an assignment to guess — get_spend, set_budget, list_findings and register_tool_server all carry a note about it. §12.8's findings job is the sharpest: it "writes cost.findings rows" into a table that does not exist, so list_findings can name no write target.
- Three pieces of state the tools are specified to change have no home in Appendix A. set_preferences (Appendix E absorbs four preference contracts) has no table: org.org_users and wrk.workspace_users carry no settings column, org.organizations.settings and wrk.workspaces.settings are the wrong grain, and auth.users is Better Auth's and unchanged. mark_notification has nowhere to store read state. §13.5 erasure destroys "a per-subject data key" that no table holds — org.organizations has only kek_key_id — so erase_data's central mechanism is unrepresented.
- Appendix E's closing arithmetic does not hold, and the matrix leaned on it. It says the wedge is "the 96 minus the eighteen marked new in the toolbelt, compliance, wrapping, and knowledge families that land from M2 onward". There are twenty (new) markers, not eighteen, and they sit in six families: identity and access (set_role_grants), wrapping (3), toolbelt (9), context and steering (get_record), spend and billing (2), audit and compliance (4). The knowledge family, which the sentence names, has none. 96 − 20 = 76, not 78. The rule "new tools land from M2 onward" was used to date load_tools, approve_tool_schema, get_record and set_role_grants, so the miscount propagates into milestones.
- Two screen values used across the assignments are not members of the SCREENS array: "Approvals" (three tools) and "headless" (three tools). Only two tools are actually headless in Appendix E. Any consumer joining on the screen column breaks on both.
- Global chrome has no representation and got encoded two incompatible ways. ask_assistant and list_conversations were given all ten screens (correct per §14.1: "The in-app agent (§4.4) sits on every screen as a side panel"), while set_preferences, list_notifications and mark_notification — equally global, and explicitly not pages per Appendix F's Account-dialog paragraph — were parked on Organization, and search_tools' command-menu half was parked on Tools. Same phenomenon, three encodings. The ten-screen model needs a chrome value, or those four rows will keep drifting.
- control.tool_calls, tools.credential_grants, tools.mandate_ledger's reserve/settle entries, and cost.run_totals are written by the gateway pipeline (§6.7 steps 3–10), the broker (§6.8) and the recorder (§12.3), none of which is an agent tool. The matrix therefore shows four tables as read-only when they are among the most written in the system. Not an assignment error — a limit of a tool-keyed matrix that a reader will misread as a coverage gap.
- Honesty flags on rows graded high that the spec does not support. rotate_api_key: "keeps the old credential valid for a grace window (so likely two rows)" appears nowhere — §15's rotation-with-validity-windows language is about bundle and attestation keys, not API keys; iam.credentials has no grace column. ingest_frames: the note itself says "medium confidence on that last one" about audit.archive_segments while the row is graded high (the claim is in fact correct — §13.3, "The archive segment is written at seal time" — but a hedged table inside a high row is a grading error). set_policy and ask_assistant repeat that pattern with wrk.workspaces and org.organizations. list_approvals and resolve_approval are graded high while naming a screen §14 says does not exist. set_member_role is high on iam.principal_role_assignments, which is inferred: the spec gives only org.org_users.role and wrk.workspace_users.role for membership, and §6.3's roles are the tool-grant roles.
- Worth recording on the credit side, because it constrains how much of the above is the matrix's fault rather than the spec's: across 96 rows there is not one invented table name — every entry is among the 37, which is a real improvement over the proposal (cost.fx_rates on register_agent, control.event_subscriptions on both subscription tools, audit.legal_holds on update_workspace, tools.policy_versions on update_org and on the ontology tools were all keyword collisions, and all were removed with the reasoning shown). All ten screens have tools. Several milestone errors were overturned correctly against the spec: link_repository M4→M0 (M0's acceptance test is verbatim "A second repo can be linked and unlinked"), list_runs M0→M1, get_run M2→M1 and export_run M0→M1 (M1 delivers render replay and "An exported run can be verified offline"), get_spend and list_findings M0→M2, export_statement M5→M2 (M2 acceptance: "An operator's statement sums exactly to their agents' runs"), export_data and erase_data M0→M5, set_kill_switch M0→M2 (§17 M2 "Kill switches"), set_funding_source M4→M1, set_model_route to Organization per §4.5 rule 2, and export_run's grade NEW→INHERIT (Appendix E: absorbs "export_data (run part)").

### Appendix A coverage

32 of 37 target tables are read or written by at least one tool.

Untouched — either a missing tool or a table that should not be in Appendix A:

- `auth.sessions`
- `auth.accounts`
- `auth.verifications`
- `cost.price_entries`
- `cost.fx_rates`

# Capabilities

Find a capability by its registered name. Pass that name to `invoke()` or use
it as the MCP tool name when the contract declares the MCP surface. ADR-025
retired dotted capability names without aliases. Dotted filenames remain in
the repository while file paths are realigned.

This index lists contract declarations, including internal contracts and
preserved implementations. A declaration does not prove that a route, handler,
or UI is wired into the current application. Check the contract,
[`packages/handlers/src/register.ts`](../../packages/handlers/src/register.ts),
and the surface bootstrap before using an entry.
[`DEREGISTERED.md`](../../DEREGISTERED.md) records retained features and the
scope decisions behind them.

Each row links to its reference page where one exists and to the source
contract. The contract defines the input, output, and declared surfaces.
`none` means no public surface is declared.

For graph reads available to the in-app agent, see
[the ontology read set](_ontology-read-set.md).

## Updating this reference

When changing a contract, update its page and the affected row below. Run
`node tools/scripts/check-capability-docs.mjs` from the repository root after
refreshing the manifest with `pnpm check:manifest`. That check compares surface
lists for matching contract and documentation filenames. Inspect pages named
after the registered name separately when their contract uses a dotted stem.

## Agent

| Capability | Contract | Declared surfaces |
| --- | --- | --- |
| [assign_agent_role](agent.role.assign.md) | [agent.role.assign.ts](../../packages/oxagen/src/contracts/agent.role.assign.ts) | api, mcp, agent |
| [attach_memory_evidence](agent.memory_evidence.attach.md) | [agent.memory_evidence.attach.ts](../../packages/oxagen/src/contracts/agent.memory_evidence.attach.ts) | api, mcp, agent |
| [bind_agent_environment](agent.environment.bind.md) | [agent.environment.bind.ts](../../packages/oxagen/src/contracts/agent.environment.bind.ts) | api, mcp, agent |
| [cite_memory](agent.memory.cite.md) | [agent.memory.cite.ts](../../packages/oxagen/src/contracts/agent.memory.cite.ts) | api, mcp, agent |
| [commit_agent_definition](agent.definition.commit.md) | [agent.definition.commit.ts](../../packages/oxagen/src/contracts/agent.definition.commit.ts) | api |
| [commit_memory_import](agent.memory_import.commit.md) | [agent.memory_import.commit.ts](../../packages/oxagen/src/contracts/agent.memory_import.commit.ts) | api, mcp, agent |
| [create_agent_def](agent.definition.create.md) | [agent.definition.create.ts](../../packages/oxagen/src/contracts/agent.definition.create.ts) | api, mcp, agent |
| [debug_execution](agent.debug.trace.md) | [agent.debug.trace.ts](../../packages/oxagen/src/contracts/agent.debug.trace.ts) | api, mcp, agent |
| [delete_agent_def](agent.definition.delete.md) | [agent.definition.delete.ts](../../packages/oxagen/src/contracts/agent.definition.delete.ts) | api, mcp, agent |
| [delete_mcp_server](agent.mcp.delete.md) | [agent.mcp.delete.ts](../../packages/oxagen/src/contracts/agent.mcp.delete.ts) | api, mcp |
| [delete_memory](agent.memory.delete.md) | [agent.memory.delete.ts](../../packages/oxagen/src/contracts/agent.memory.delete.ts) | api, mcp, agent |
| [demote_memory](agent.memory.demote.md) | [agent.memory.demote.ts](../../packages/oxagen/src/contracts/agent.memory.demote.ts) | api, mcp, agent |
| [deploy_agent](agent.deploy.md) | [agent.deploy.ts](../../packages/oxagen/src/contracts/agent.deploy.ts) | api, mcp, agent |
| [dismiss_memory_promotion](agent.memory_promotion.dismiss.md) | [agent.memory_promotion.dismiss.ts](../../packages/oxagen/src/contracts/agent.memory_promotion.dismiss.ts) | api, mcp, agent |
| [get_agent](agent.get.md) | [agent.get.ts](../../packages/oxagen/src/contracts/agent.get.ts) | api, mcp, cli |
| [get_agent_def](agent.definition.get.md) | [agent.definition.get.ts](../../packages/oxagen/src/contracts/agent.definition.get.ts) | api, mcp, agent |
| [get_agent_role](agent.role.get.md) | [agent.role.get.ts](../../packages/oxagen/src/contracts/agent.role.get.ts) | api, mcp, agent |
| [get_agent_toolbelt](agent.toolbelt.get.md) | [agent.toolbelt.get.ts](../../packages/oxagen/src/contracts/agent.toolbelt.get.ts) | api, mcp |
| [get_citation_stats](agent.memory_citation.stats.md) | [agent.memory_citation.stats.ts](../../packages/oxagen/src/contracts/agent.memory_citation.stats.ts) | api, mcp, agent |
| [get_execution_trace](agent.trace.get.md) | [agent.trace.get.ts](../../packages/oxagen/src/contracts/agent.trace.get.ts) | api, mcp, agent |
| [get_memory_policy](agent.memory_policy.read.md) | [agent.memory_policy.read.ts](../../packages/oxagen/src/contracts/agent.memory_policy.read.ts) | api, mcp, agent |
| [list_agent_defs](agent.definition.list.md) | [agent.definition.list.ts](../../packages/oxagen/src/contracts/agent.definition.list.ts) | api, mcp, agent |
| [list_agent_environments](agent.environment.list.md) | [agent.environment.list.ts](../../packages/oxagen/src/contracts/agent.environment.list.ts) | api, mcp, agent |
| [list_agent_roles](agent.role.list.md) | [agent.role.list.ts](../../packages/oxagen/src/contracts/agent.role.list.ts) | api, mcp, agent |
| [list_agent_tools](agent.tool.list.md) | [agent.tool.list.ts](../../packages/oxagen/src/contracts/agent.tool.list.ts) | api, mcp, agent |
| [list_agents](agent.list.md) | [agent.list.ts](../../packages/oxagen/src/contracts/agent.list.ts) | api, mcp |
| [list_approvals](agent.approval.list.md) | [agent.approval.list.ts](../../packages/oxagen/src/contracts/agent.approval.list.ts) | api, mcp |
| [list_executions](agent.execution.list.md) | [agent.execution.list.ts](../../packages/oxagen/src/contracts/agent.execution.list.ts) | api, mcp, agent |
| [list_mcp_consents](agent.mcp_consent.list.md) | [agent.mcp_consent.list.ts](../../packages/oxagen/src/contracts/agent.mcp_consent.list.ts) | api, mcp, agent |
| [list_mcp_servers](agent.mcp.list.md) | [agent.mcp.list.ts](../../packages/oxagen/src/contracts/agent.mcp.list.ts) | api, mcp, agent |
| [list_memories](agent.memory.list.md) | [agent.memory.list.ts](../../packages/oxagen/src/contracts/agent.memory.list.ts) | api, mcp, agent |
| [list_memory_citations](agent.memory_citation.list.md) | [agent.memory_citation.list.ts](../../packages/oxagen/src/contracts/agent.memory_citation.list.ts) | api, mcp, agent |
| [list_memory_promotions](agent.memory_promotion.list.md) | [agent.memory_promotion.list.ts](../../packages/oxagen/src/contracts/agent.memory_promotion.list.ts) | api, mcp, agent |
| [parse_memory_import](agent.memory_import.parse.md) | [agent.memory_import.parse.ts](../../packages/oxagen/src/contracts/agent.memory_import.parse.ts) | api, mcp, agent |
| [promote_memory](agent.memory.promote.md) | [agent.memory.promote.ts](../../packages/oxagen/src/contracts/agent.memory.promote.ts) | api, mcp, agent |
| [propose_agent](agent.propose.md) | [agent.propose.ts](../../packages/oxagen/src/contracts/agent.propose.ts) | api |
| [publish_agent_def](agent.definition.publish.md) | [agent.definition.publish.ts](../../packages/oxagen/src/contracts/agent.definition.publish.ts) | api, mcp, agent |
| [recall_memory](agent.memory.recall.md) | [agent.memory.recall.ts](../../packages/oxagen/src/contracts/agent.memory.recall.ts) | api, mcp, agent |
| [record_execution](agent.execution.record.md) | [agent.execution.record.ts](../../packages/oxagen/src/contracts/agent.execution.record.ts) | api, mcp |
| [register_agent](agent.register.md) | [agent.register.ts](../../packages/oxagen/src/contracts/agent.register.ts) | api, cli |
| [register_mcp_server](agent.mcp.register.md) | [agent.mcp.register.ts](../../packages/oxagen/src/contracts/agent.mcp.register.ts) | api, mcp |
| [resolve_approval](agent.approval.resolve.md) | [agent.approval.resolve.ts](../../packages/oxagen/src/contracts/agent.approval.resolve.ts) | api, mcp, agent |
| [resolve_mcp_consent](agent.mcp_consent.resolve.md) | [agent.mcp_consent.resolve.ts](../../packages/oxagen/src/contracts/agent.mcp_consent.resolve.ts) | api, mcp, agent |
| `resolve_mcp_servers` | [agent.mcp.resolve.ts](../../packages/oxagen/src/contracts/agent.mcp.resolve.ts) | api |
| [retire_agent](agent.retire.md) | [agent.retire.ts](../../packages/oxagen/src/contracts/agent.retire.ts) | api |
| [revise_agent_def](revise_agent_def.md) | [agent.definition.revise.ts](../../packages/oxagen/src/contracts/agent.definition.revise.ts) | api, mcp, agent |
| [revoke_agent_role](agent.role.revoke.md) | [agent.role.revoke.ts](../../packages/oxagen/src/contracts/agent.role.revoke.ts) | api, mcp, agent |
| [rotate_agent_credential](agent.credential.rotate.md) | [agent.credential.rotate.ts](../../packages/oxagen/src/contracts/agent.credential.rotate.ts) | api |
| [save_memory](agent.memory.remember.md) | [agent.memory.remember.ts](../../packages/oxagen/src/contracts/agent.memory.remember.ts) | api, mcp, agent |
| [set_mcp_enabled](agent.mcp.set_enabled.md) | [agent.mcp.set_enabled.ts](../../packages/oxagen/src/contracts/agent.mcp.set_enabled.ts) | api, mcp |
| [suggest_agent_def](agent.definition.suggest.md) | [agent.definition.suggest.ts](../../packages/oxagen/src/contracts/agent.definition.suggest.ts) | api, mcp, agent |
| [suggest_promotion_rationales](agent.memory_promotion.rationales.md) | [agent.memory_promotion.rationales.ts](../../packages/oxagen/src/contracts/agent.memory_promotion.rationales.ts) | api, mcp, agent |
| [summarize_agent_def](agent.definition.summarize.md) | [agent.definition.summarize.ts](../../packages/oxagen/src/contracts/agent.definition.summarize.ts) | api, mcp, agent |
| [suspend_agent](agent.suspend.md) | [agent.suspend.ts](../../packages/oxagen/src/contracts/agent.suspend.ts) | api |
| [unbind_agent_environment](agent.environment.unbind.md) | [agent.environment.unbind.ts](../../packages/oxagen/src/contracts/agent.environment.unbind.ts) | api, mcp, agent |
| [update_agent_def](agent.definition.update.md) | [agent.definition.update.ts](../../packages/oxagen/src/contracts/agent.definition.update.ts) | api, mcp, agent |
| [update_memory](agent.memory.update.md) | [agent.memory.update.ts](../../packages/oxagen/src/contracts/agent.memory.update.ts) | api, mcp, agent |
| [update_memory_policy](agent.memory_policy.write.md) | [agent.memory_policy.write.ts](../../packages/oxagen/src/contracts/agent.memory_policy.write.ts) | api, mcp, agent |
| [write_memory](agent.memory.write.md) | [agent.memory.write.ts](../../packages/oxagen/src/contracts/agent.memory.write.ts) | api, mcp, agent |

## Api key

| Capability | Contract | Declared surfaces |
| --- | --- | --- |
| [create_api_key](api.key.create.md) | [api.key.create.ts](../../packages/oxagen/src/contracts/api.key.create.ts) | api, mcp, agent |
| [list_api_keys](api.key.list.md) | [api.key.list.ts](../../packages/oxagen/src/contracts/api.key.list.ts) | api, mcp |
| [revoke_api_key](api.key.revoke.md) | [api.key.revoke.ts](../../packages/oxagen/src/contracts/api.key.revoke.ts) | api, mcp, agent |
| [rotate_api_key](api.key.rotate.md) | [api.key.rotate.ts](../../packages/oxagen/src/contracts/api.key.rotate.ts) | api, mcp, agent |

## Approval rule

| Capability | Contract | Declared surfaces |
| --- | --- | --- |
| [delete_approval_rule](delete_approval_rule.md) | [approval_rule.delete.ts](../../packages/oxagen/src/contracts/approval_rule.delete.ts) | api, mcp, agent |
| [get_auto_eligibility](get_auto_eligibility.md) | [approval.auto_eligibility.get.ts](../../packages/oxagen/src/contracts/approval.auto_eligibility.get.ts) | api, mcp |
| [list_approval_rules](list_approval_rules.md) | [approval_rule.list.ts](../../packages/oxagen/src/contracts/approval_rule.list.ts) | api, mcp |
| [set_approval_rule_enabled](set_approval_rule_enabled.md) | [approval_rule.enabled.set.ts](../../packages/oxagen/src/contracts/approval_rule.enabled.set.ts) | api, mcp, agent |
| [set_approval_rules](set_approval_rules.md) | [approval_rule.set.ts](../../packages/oxagen/src/contracts/approval_rule.set.ts) | api, mcp, agent |

## Asset

| Capability | Contract | Declared surfaces |
| --- | --- | --- |
| [upload_asset](asset.upload.md) | [asset.upload.ts](../../packages/oxagen/src/contracts/asset.upload.ts) | api, mcp, agent |

## Assistant

| Capability | Contract | Declared surfaces |
| --- | --- | --- |
| [ask_assistant](assistant.ask.md) | [assistant.ask.ts](../../packages/oxagen/src/contracts/assistant.ask.ts) | api, mcp |
| [get_assistant_engine](assistant.engine.get.md) | [assistant.engine.get.ts](../../packages/oxagen/src/contracts/assistant.engine.get.ts) | api, mcp |

## Audit

| Capability | Contract | Declared surfaces |
| --- | --- | --- |
| [export_audit_events](audit.events.export.md) | [audit.events.export.ts](../../packages/oxagen/src/contracts/audit.events.export.ts) | api, mcp |
| [query_audit_log](audit.log.query.md) | [audit.log.query.ts](../../packages/oxagen/src/contracts/audit.log.query.ts) | api, mcp, agent, cli |

## Auth

| Capability | Contract | Declared surfaces |
| --- | --- | --- |
| [authorize_cli](auth.cli.authorize.md) | [auth.cli.authorize.ts](../../packages/oxagen/src/contracts/auth.cli.authorize.ts) | none |

## Billing

| Capability | Contract | Declared surfaces |
| --- | --- | --- |
| [get_contract_rate](billing.contract_rate.get.md) | [billing.contract_rate.get.ts](../../packages/oxagen/src/contracts/billing.contract_rate.get.ts) | api, mcp, agent |
| [get_evidence_retention](billing.evidence_retention.md) | [billing.evidence_retention.ts](../../packages/oxagen/src/contracts/billing.evidence_retention.ts) | api, mcp, agent |
| [get_gau_bucket](billing.gau_bucket.get.md) | [billing.gau_bucket.get.ts](../../packages/oxagen/src/contracts/billing.gau_bucket.get.ts) | api, mcp |
| [get_rate_card](billing.action_rate_card.md) | [billing.action_rate_card.ts](../../packages/oxagen/src/contracts/billing.action_rate_card.ts) | api, mcp, agent |
| [get_spend_budget](billing.budget.get.md) | [billing.budget.get.ts](../../packages/oxagen/src/contracts/billing.budget.get.ts) | api, mcp, agent, cli |
| [get_subscription](billing.subscription.read.md) | [billing.subscription.read.ts](../../packages/oxagen/src/contracts/billing.subscription.read.ts) | api, mcp, agent |
| [get_usage_breakdown](billing.usage.breakdown.md) | [billing.usage.breakdown.ts](../../packages/oxagen/src/contracts/billing.usage.breakdown.ts) | api, mcp, agent |
| [list_invoices](billing.invoice.list.md) | [billing.invoice.list.ts](../../packages/oxagen/src/contracts/billing.invoice.list.ts) | api, mcp |
| [preview_action_cost](billing.action_estimate.md) | [billing.action_estimate.ts](../../packages/oxagen/src/contracts/billing.action_estimate.ts) | api, mcp, agent |
| [purchase_credits](billing.credits.purchase.md) | [billing.credits.purchase.ts](../../packages/oxagen/src/contracts/billing.credits.purchase.ts) | api, mcp, agent |
| [purchase_gau_bucket](billing.gau_bucket.purchase.md) | [billing.gau_bucket.purchase.ts](../../packages/oxagen/src/contracts/billing.gau_bucket.purchase.ts) | api, mcp, agent |
| [set_auto_topup](billing.auto_topup.set.md) | [billing.auto_topup.set.ts](../../packages/oxagen/src/contracts/billing.auto_topup.set.ts) | api, mcp |
| [set_org_billing_terms](billing.org_terms.set.md) | [billing.org_terms.set.ts](../../packages/oxagen/src/contracts/billing.org_terms.set.ts) | none |
| [set_spend_budget](billing.budget.set.md) | [billing.budget.set.ts](../../packages/oxagen/src/contracts/billing.budget.set.ts) | api, mcp, agent, cli |
| [start_subscription_upgrade](billing.subscription_upgrade.start.md) | [billing.subscription_upgrade.start.ts](../../packages/oxagen/src/contracts/billing.subscription_upgrade.start.ts) | api, mcp, agent |

## Capability

| Capability | Contract | Declared surfaces |
| --- | --- | --- |
| [get_capability_registry](capability.registry.get.md) | [capability.registry.get.ts](../../packages/oxagen/src/contracts/capability.registry.get.ts) | api, mcp, agent |
| [list_capability_registry](capability.registry.list.md) | [capability.registry.list.ts](../../packages/oxagen/src/contracts/capability.registry.list.ts) | api, mcp, agent |

## Chat

| Capability | Contract | Declared surfaces |
| --- | --- | --- |
| [get_message_execution](chat.message.execution.md) | [chat.message.execution.ts](../../packages/oxagen/src/contracts/chat.message.execution.ts) | api, mcp |
| [send_message](chat.message.send.md) | [chat.message.send.ts](../../packages/oxagen/src/contracts/chat.message.send.ts) | api, mcp |

## Command

| Capability | Contract | Declared surfaces |
| --- | --- | --- |
| [search_command_menu](command.menu.search.md) | [command.menu.search.ts](../../packages/oxagen/src/contracts/command.menu.search.ts) | api, agent |
| [suggest_commands](command.menu.suggest.md) | [command.menu.suggest.ts](../../packages/oxagen/src/contracts/command.menu.suggest.ts) | api, agent |

## Connection

| Capability | Contract | Declared surfaces |
| --- | --- | --- |
| [create_connection](connection.create.md) | [connection.create.ts](../../packages/oxagen/src/contracts/connection.create.ts) | api, mcp, agent |
| [delete_connection](connection.delete.md) | [connection.delete.ts](../../packages/oxagen/src/contracts/connection.delete.ts) | api, mcp, agent |
| [get_connection](connection.get.md) | [connection.get.ts](../../packages/oxagen/src/contracts/connection.get.ts) | api, mcp, agent |
| [get_connection_mappings](connection.mappings.get.md) | [connection.mappings.get.ts](../../packages/oxagen/src/contracts/connection.mappings.get.ts) | api, mcp, agent |
| [list_connections](connection.list.md) | [connection.list.ts](../../packages/oxagen/src/contracts/connection.list.ts) | api, mcp, agent |
| [pause_connection](connection.pause.md) | [connection.pause.ts](../../packages/oxagen/src/contracts/connection.pause.ts) | api, mcp, agent |
| [preview_connection](connection.preview.md) | [connection.preview.ts](../../packages/oxagen/src/contracts/connection.preview.ts) | api, mcp, agent |
| [set_connection_mappings](connection.mappings.set.md) | [connection.mappings.set.ts](../../packages/oxagen/src/contracts/connection.mappings.set.ts) | api, mcp, agent |
| [suggest_connection_mappings](connection.mappings.suggest.md) | [connection.mappings.suggest.ts](../../packages/oxagen/src/contracts/connection.mappings.suggest.ts) | api, mcp, agent |
| [update_connection](connection.update.md) | [connection.update.ts](../../packages/oxagen/src/contracts/connection.update.ts) | api, mcp, agent |

## Context

| Capability | Contract | Declared surfaces |
| --- | --- | --- |
| [append_record](context.records.append.md) | [context.records.append.ts](../../packages/oxagen/src/contracts/context.records.append.ts) | api, mcp, agent |
| [dismiss_proposal](context.proposal.dismiss.md) | [context.proposal.dismiss.ts](../../packages/oxagen/src/contracts/context.proposal.dismiss.ts) | api |
| [get_context_pr](context.pr.get.md) | [context.pr.get.ts](../../packages/oxagen/src/contracts/context.pr.get.ts) | api, mcp |
| [get_record](context.records.get.md) | [context.records.get.ts](../../packages/oxagen/src/contracts/context.records.get.ts) | api, mcp, agent |
| `get_steering_freshness` | [context.steering.freshness.ts](../../packages/oxagen/src/contracts/context.steering.freshness.ts) | api, mcp, agent |
| [list_context_records](context.record.list.md) | [context.record.list.ts](../../packages/oxagen/src/contracts/context.record.list.ts) | api, agent, mcp |
| [list_proposals](context.proposal.list.md) | [context.proposal.list.ts](../../packages/oxagen/src/contracts/context.proposal.list.ts) | api, mcp |
| [list_records](context.records.list.md) | [context.records.list.ts](../../packages/oxagen/src/contracts/context.records.list.ts) | api, mcp, agent |
| [merge_context_pr](context.pr.merge.md) | [context.pr.merge.ts](../../packages/oxagen/src/contracts/context.pr.merge.ts) | api |
| [open_context_pr](context.pr.open.md) | [context.pr.open.ts](../../packages/oxagen/src/contracts/context.pr.open.ts) | api |
| [promote_context_record](context.record.promote.md) | [context.record.promote.ts](../../packages/oxagen/src/contracts/context.record.promote.ts) | api |
| [propose_record](context.proposal.create.md) | [context.proposal.create.ts](../../packages/oxagen/src/contracts/context.proposal.create.ts) | api, mcp, agent |
| [publish_context_record](context.record.publish.md) | [context.record.publish.ts](../../packages/oxagen/src/contracts/context.record.publish.ts) | api |

## Control

| Capability | Contract | Declared surfaces |
| --- | --- | --- |
| [dispatch_command](tacho.command.dispatch.md) | [tacho.command.dispatch.ts](../../packages/oxagen/src/contracts/tacho.command.dispatch.ts) | api, mcp |
| [fetch_commands](tacho.command.fetch.md) | [tacho.command.fetch.ts](../../packages/oxagen/src/contracts/tacho.command.fetch.ts) | api |
| [list_commands](tacho.command.list.md) | [tacho.command.list.ts](../../packages/oxagen/src/contracts/tacho.command.list.ts) | api, mcp |

## Conversation

| Capability | Contract | Declared surfaces |
| --- | --- | --- |
| [add_conversation_attachment](conversation.attachment.add.md) | [conversation.attachment.add.ts](../../packages/oxagen/src/contracts/conversation.attachment.add.ts) | api, mcp, agent |
| [archive_conversation](conversation.archive.md) | [conversation.archive.ts](../../packages/oxagen/src/contracts/conversation.archive.ts) | api, mcp, agent |
| [delete_conversation](conversation.delete.md) | [conversation.delete.ts](../../packages/oxagen/src/contracts/conversation.delete.ts) | api, mcp, agent |
| [export_conversation](conversation.export.md) | [conversation.export.ts](../../packages/oxagen/src/contracts/conversation.export.ts) | api, mcp, agent |
| [list_conversation_files](conversation.files.list.md) | [conversation.files.list.ts](../../packages/oxagen/src/contracts/conversation.files.list.ts) | api, mcp, agent |
| [list_conversations](conversation.list.md) | [conversation.list.ts](../../packages/oxagen/src/contracts/conversation.list.ts) | api, mcp, agent |
| [post_conversation_message](conversation.chat.md) | [conversation.chat.ts](../../packages/oxagen/src/contracts/conversation.chat.ts) | api, mcp |
| [purge_conversations](conversation.purge.md) | [conversation.purge.ts](../../packages/oxagen/src/contracts/conversation.purge.ts) | api, mcp, agent |
| [rename_conversation](conversation.rename.md) | [conversation.rename.ts](../../packages/oxagen/src/contracts/conversation.rename.ts) | api, mcp, agent |

## Cost

| Capability | Contract | Declared surfaces |
| --- | --- | --- |
| [list_price_entries](cost.price_entry.list.md) | [cost.price_entry.list.ts](../../packages/oxagen/src/contracts/cost.price_entry.list.ts) | api, mcp |
| [list_unpriced_models](cost.unpriced_model.list.md) | [cost.unpriced_model.list.ts](../../packages/oxagen/src/contracts/cost.unpriced_model.list.ts) | api, mcp |
| [remove_price_entry](cost.price_entry.remove.md) | [cost.price_entry.remove.ts](../../packages/oxagen/src/contracts/cost.price_entry.remove.ts) | api, mcp, cli |
| [set_price_entry](cost.price_entry.set.md) | [cost.price_entry.set.ts](../../packages/oxagen/src/contracts/cost.price_entry.set.ts) | api, mcp, cli |

## Credential

| Capability | Contract | Declared surfaces |
| --- | --- | --- |
| [list_credential_grants](credential.grant.list.md) | [credential.grant.list.ts](../../packages/oxagen/src/contracts/credential.grant.list.ts) | api, mcp |

## Environment

| Capability | Contract | Declared surfaces |
| --- | --- | --- |
| [create_environment](environment.create.md) | [environment.create.ts](../../packages/oxagen/src/contracts/environment.create.ts) | api, mcp, agent |
| [delete_environment](environment.delete.md) | [environment.delete.ts](../../packages/oxagen/src/contracts/environment.delete.ts) | api, mcp, agent |
| [get_environment](environment.get.md) | [environment.get.ts](../../packages/oxagen/src/contracts/environment.get.ts) | api, mcp, agent |
| [list_environments](environment.list.md) | [environment.list.ts](../../packages/oxagen/src/contracts/environment.list.ts) | api, mcp, agent |
| [set_default_environment](environment.set_default.md) | [environment.set_default.ts](../../packages/oxagen/src/contracts/environment.set_default.ts) | api, mcp, agent |
| [update_environment](environment.update.md) | [environment.update.ts](../../packages/oxagen/src/contracts/environment.update.ts) | api, mcp, agent |

## Evidence

| Capability | Contract | Declared surfaces |
| --- | --- | --- |
| [set_disclosure_grain](evidence.disclosure_grain.set.md) | [evidence.disclosure_grain.set.ts](../../packages/oxagen/src/contracts/evidence.disclosure_grain.set.ts) | api |

## Graph

| Capability | Contract | Declared surfaces |
| --- | --- | --- |
| [get_graph_stats](graph.stats.md) | [graph.stats.ts](../../packages/oxagen/src/contracts/graph.stats.ts) | api, mcp, agent |
| [get_node](graph.node.get.md) | [graph.node.get.ts](../../packages/oxagen/src/contracts/graph.node.get.ts) | api, mcp, agent, cli |
| [get_node_labels](graph.node_label.get.md) | [graph.node_label.get.ts](../../packages/oxagen/src/contracts/graph.node_label.get.ts) | agent |
| [list_nodes](graph.node.list.md) | [graph.node.list.ts](../../packages/oxagen/src/contracts/graph.node.list.ts) | api, mcp, agent |
| [search_graph](graph.search.md) | [graph.search.ts](../../packages/oxagen/src/contracts/graph.search.ts) | api, mcp, agent, cli |
| [search_nodes](graph.node.search.md) | [graph.node.search.ts](../../packages/oxagen/src/contracts/graph.node.search.ts) | api, mcp, agent, cli |

## Iam

| Capability | Contract | Declared surfaces |
| --- | --- | --- |
| [create_role](iam.role.create.md) | [iam.role.create.ts](../../packages/oxagen/src/contracts/iam.role.create.ts) | api, mcp, agent |
| [delete_role](iam.role.delete.md) | [iam.role.delete.ts](../../packages/oxagen/src/contracts/iam.role.delete.ts) | api, mcp, agent |
| [list_iam_roles](iam.role.list.md) | [iam.role.list.ts](../../packages/oxagen/src/contracts/iam.role.list.ts) | api, mcp, agent |
| [set_role_grants](iam.role.grants.set.md) | [iam.role.grants.set.ts](../../packages/oxagen/src/contracts/iam.role.grants.set.ts) | api, mcp, agent |

## Integration

| Capability | Contract | Declared surfaces |
| --- | --- | --- |
| [configure_integration](integration.configure.md) | [integration.configure.ts](../../packages/oxagen/src/contracts/integration.configure.ts) | api, mcp, cli, agent |
| [delete_integration](integration.delete.md) | [integration.delete.ts](../../packages/oxagen/src/contracts/integration.delete.ts) | api, mcp, cli, agent |
| [get_integration](integration.get.md) | [integration.get.ts](../../packages/oxagen/src/contracts/integration.get.ts) | api, mcp, cli, agent |
| [get_integration_metrics](integration.metrics.md) | [integration.metrics.ts](../../packages/oxagen/src/contracts/integration.metrics.ts) | api, mcp, agent |
| [install_integration](integration.install.md) | [integration.install.ts](../../packages/oxagen/src/contracts/integration.install.ts) | api, mcp, cli, agent |
| [list_integrations](integration.list.md) | [integration.list.ts](../../packages/oxagen/src/contracts/integration.list.ts) | api, mcp, cli, agent |
| [sync_integration](integration.sync.md) | [integration.sync.ts](../../packages/oxagen/src/contracts/integration.sync.ts) | api, mcp, cli, agent |

## Kill switch

| Capability | Contract | Declared surfaces |
| --- | --- | --- |
| [list_kill_switches](kill_switch.list.md) | [kill_switch.list.ts](../../packages/oxagen/src/contracts/kill_switch.list.ts) | api, mcp |
| [set_kill_switch](kill_switch.set.md) | [kill_switch.set.ts](../../packages/oxagen/src/contracts/kill_switch.set.ts) | api, mcp, agent |

## Mandate

| Capability | Contract | Declared surfaces |
| --- | --- | --- |
| [get_mandate](get_mandate.md) | [mandate.get.ts](../../packages/oxagen/src/contracts/mandate.get.ts) | api, mcp, agent |
| [grant_mandate](grant_mandate.md) | [mandate.grant.ts](../../packages/oxagen/src/contracts/mandate.grant.ts) | api, mcp, agent |
| [list_mandates](list_mandates.md) | [mandate.list.ts](../../packages/oxagen/src/contracts/mandate.list.ts) | api, mcp, agent |
| [request_mandate](request_mandate.md) | [mandate.request.ts](../../packages/oxagen/src/contracts/mandate.request.ts) | api, mcp, agent |
| [revoke_mandate](revoke_mandate.md) | [mandate.revoke.ts](../../packages/oxagen/src/contracts/mandate.revoke.ts) | api, mcp, agent |
| [update_mandate_limits](update_mandate_limits.md) | [mandate.limits.update.ts](../../packages/oxagen/src/contracts/mandate.limits.update.ts) | api, mcp, agent |

## Model

| Capability | Contract | Declared surfaces |
| --- | --- | --- |
| [list_model_capabilities](model.capability.list.md) | [model.capability.list.ts](../../packages/oxagen/src/contracts/model.capability.list.ts) | api, mcp, agent |

## Notification

| Capability | Contract | Declared surfaces |
| --- | --- | --- |
| [list_notifications](notification.list.md) | [notification.list.ts](../../packages/oxagen/src/contracts/notification.list.ts) | api, mcp, agent |
| [mark_notification](notification.mark.md) | [notification.mark.ts](../../packages/oxagen/src/contracts/notification.mark.ts) | api, mcp, agent |

## Onboarding

| Capability | Contract | Declared surfaces |
| --- | --- | --- |
| [advance_onboarding](onboarding.advance.md) | [onboarding.advance.ts](../../packages/oxagen/src/contracts/onboarding.advance.ts) | api |
| [get_first_frame](onboarding.first_frame.get.md) | [onboarding.first_frame.get.ts](../../packages/oxagen/src/contracts/onboarding.first_frame.get.ts) | api, mcp |
| [get_onboarding_state](onboarding.state.get.md) | [onboarding.state.get.ts](../../packages/oxagen/src/contracts/onboarding.state.get.ts) | api, mcp |

## Ontology

| Capability | Contract | Declared surfaces |
| --- | --- | --- |
| [get_ontology_neighbors](ontology.neighbors.md) | [ontology.neighbors.ts](../../packages/oxagen/src/contracts/ontology.neighbors.ts) | api, mcp, agent, cli |
| [query_ontology](ontology.query.md) | [ontology.query.ts](../../packages/oxagen/src/contracts/ontology.query.ts) | api, mcp, agent, cli |

## Org

| Capability | Contract | Declared surfaces |
| --- | --- | --- |
| [accept_member_invite](org.member_invite.accept.md) | [org.member_invite.accept.ts](../../packages/oxagen/src/contracts/org.member_invite.accept.ts) | api, mcp, agent |
| [add_org_member](org.member.add.md) | [org.member.add.ts](../../packages/oxagen/src/contracts/org.member.add.ts) | api, mcp, agent |
| [change_member_role](org.member_role.change.md) | [org.member_role.change.ts](../../packages/oxagen/src/contracts/org.member_role.change.ts) | api, mcp, agent |
| [create_org](org.create.md) | [org.create.ts](../../packages/oxagen/src/contracts/org.create.ts) | api, mcp, agent |
| [decline_member_invite](org.member_invite.decline.md) | [org.member_invite.decline.ts](../../packages/oxagen/src/contracts/org.member_invite.decline.ts) | api, mcp, agent |
| [delete_model_credential](delete_model_credential.md) | [org.model_credential.delete.ts](../../packages/oxagen/src/contracts/org.model_credential.delete.ts) | api, mcp |
| [get_data_plane](get_data_plane.md) | [org.data_plane.get.ts](../../packages/oxagen/src/contracts/org.data_plane.get.ts) | api, mcp |
| [get_model_credential](get_model_credential.md) | [org.model_credential.get.ts](../../packages/oxagen/src/contracts/org.model_credential.get.ts) | api, mcp |
| [get_org_settings](org.settings.read.md) | [org.settings.read.ts](../../packages/oxagen/src/contracts/org.settings.read.ts) | api, mcp, agent |
| [list_members](workspace.member.list.md) | [workspace.member.list.ts](../../packages/oxagen/src/contracts/workspace.member.list.ts) | api, mcp |
| [list_orgs](org.list.md) | [org.list.ts](../../packages/oxagen/src/contracts/org.list.ts) | api, mcp, agent |
| [remove_org_member](org.member.remove.md) | [org.member.remove.ts](../../packages/oxagen/src/contracts/org.member.remove.ts) | api, mcp, agent |
| [set_data_plane](set_data_plane.md) | [org.data_plane.set.ts](../../packages/oxagen/src/contracts/org.data_plane.set.ts) | api, mcp |
| [set_model_credential](set_model_credential.md) | [org.model_credential.set.ts](../../packages/oxagen/src/contracts/org.model_credential.set.ts) | api, mcp |
| [update_org_settings](org.settings.write.md) | [org.settings.write.ts](../../packages/oxagen/src/contracts/org.settings.write.ts) | api, mcp, agent |
| [verify_model_credential](verify_model_credential.md) | [org.model_credential.verify.ts](../../packages/oxagen/src/contracts/org.model_credential.verify.ts) | api, mcp |

## Plugin

| Capability | Contract | Declared surfaces |
| --- | --- | --- |
| [add_plugin_registry](plugin.registry.add.md) | [plugin.registry.add.ts](../../packages/oxagen/src/contracts/plugin.registry.add.ts) | api, mcp, agent |
| [browse_plugin_catalog](plugin.catalog.browse.md) | [plugin.catalog.browse.ts](../../packages/oxagen/src/contracts/plugin.catalog.browse.ts) | api, mcp, agent |
| [get_auth_alerts](plugin.settings.get_auth_alerts.md) | [plugin.settings.get_auth_alerts.ts](../../packages/oxagen/src/contracts/plugin.settings.get_auth_alerts.ts) | api, mcp, agent |
| [get_catalog_plugin](plugin.catalog.get.md) | [plugin.catalog.get.ts](../../packages/oxagen/src/contracts/plugin.catalog.get.ts) | api, mcp, agent |
| [get_plugin_schema](plugin.schema.get.md) | [plugin.schema.get.ts](../../packages/oxagen/src/contracts/plugin.schema.get.ts) | api, mcp, agent |
| [install_plugin](plugin.org.install.md) | [plugin.org.install.ts](../../packages/oxagen/src/contracts/plugin.org.install.ts) | api, mcp, agent |
| [install_plugins_bulk](plugin.org.install_bulk.md) | [plugin.org.install_bulk.ts](../../packages/oxagen/src/contracts/plugin.org.install_bulk.ts) | api, mcp, agent |
| [list_plugin_registries](plugin.registry.list.md) | [plugin.registry.list.ts](../../packages/oxagen/src/contracts/plugin.registry.list.ts) | api, mcp, agent |
| [list_plugin_versions](plugin.version.list.md) | [plugin.version.list.ts](../../packages/oxagen/src/contracts/plugin.version.list.ts) | api, mcp, agent |
| [list_plugins](plugin.org.list.md) | [plugin.org.list.ts](../../packages/oxagen/src/contracts/plugin.org.list.ts) | api, mcp, agent |
| [reauth_plugin_credential](plugin.credential.reauth.md) | [plugin.credential.reauth.ts](../../packages/oxagen/src/contracts/plugin.credential.reauth.ts) | api, mcp, agent |
| [remove_plugin_registry](plugin.registry.remove.md) | [plugin.registry.remove.ts](../../packages/oxagen/src/contracts/plugin.registry.remove.ts) | api, mcp, agent |
| [revoke_plugin_credential](plugin.credential.revoke.md) | [plugin.credential.revoke.ts](../../packages/oxagen/src/contracts/plugin.credential.revoke.ts) | api, mcp, agent |
| [set_auth_alerts](plugin.settings.set_auth_alerts.md) | [plugin.settings.set_auth_alerts.ts](../../packages/oxagen/src/contracts/plugin.settings.set_auth_alerts.ts) | api, mcp, agent |
| [set_plugin_enabled](plugin.set_enabled.md) | [plugin.set_enabled.ts](../../packages/oxagen/src/contracts/plugin.set_enabled.ts) | api, mcp, agent |
| [set_plugin_secret](plugin.credential.set_secret.md) | [plugin.credential.set_secret.ts](../../packages/oxagen/src/contracts/plugin.credential.set_secret.ts) | api, mcp, agent |
| [sync_plugin_catalog](plugin.catalog.sync.md) | [plugin.catalog.sync.ts](../../packages/oxagen/src/contracts/plugin.catalog.sync.ts) | api, mcp |
| [uninstall_plugin](plugin.org.uninstall.md) | [plugin.org.uninstall.ts](../../packages/oxagen/src/contracts/plugin.org.uninstall.ts) | api, mcp, agent |
| [validate_plugin_schema](plugin.schema.validate.md) | [plugin.schema.validate.ts](../../packages/oxagen/src/contracts/plugin.schema.validate.ts) | api, mcp, agent |

## Privacy

| Capability | Contract | Declared surfaces |
| --- | --- | --- |
| [erase_data](privacy.data.erase.md) | [privacy.data.erase.ts](../../packages/oxagen/src/contracts/privacy.data.erase.ts) | api, mcp, agent |
| [export_data](privacy.data.export.md) | [privacy.data.export.ts](../../packages/oxagen/src/contracts/privacy.data.export.ts) | api, mcp, agent |
| [get_export_status](privacy.data.export.status.md) | [privacy.data.export.status.ts](../../packages/oxagen/src/contracts/privacy.data.export.status.ts) | api |

## Reference

| Capability | Contract | Declared surfaces |
| --- | --- | --- |
| [cite_reference](reference.cite.md) | [reference.cite.ts](../../packages/oxagen/src/contracts/reference.cite.ts) | agent |
| [search_references](reference.search.md) | [reference.search.ts](../../packages/oxagen/src/contracts/reference.search.ts) | api, mcp, agent |

## Repo

| Capability | Contract | Declared surfaces |
| --- | --- | --- |
| [configure_repo](repo.configure.md) | [repo.configure.ts](../../packages/oxagen/src/contracts/repo.configure.ts) | api, mcp, cli, agent |
| [get_ci_status](repo.ci.status.md) | [repo.ci.status.ts](../../packages/oxagen/src/contracts/repo.ci.status.ts) | agent, api, mcp |
| [get_pr](repo.pr.get.md) | [repo.pr.get.ts](../../packages/oxagen/src/contracts/repo.pr.get.ts) | agent, api, mcp |
| [get_pr_diff](repo.pr.diff.md) | [repo.pr.diff.ts](../../packages/oxagen/src/contracts/repo.pr.diff.ts) | agent, api, mcp |
| [get_repo_metrics](repo.metrics.md) | [repo.metrics.ts](../../packages/oxagen/src/contracts/repo.metrics.ts) | api, mcp, agent |
| `list_branches` | [repo.branch.list.ts](../../packages/oxagen/src/contracts/repo.branch.list.ts) | agent, api, mcp |
| [pause_repo](repo.pause.md) | [repo.pause.ts](../../packages/oxagen/src/contracts/repo.pause.ts) | api, mcp, cli, agent |
| [resume_repo](repo.resume.md) | [repo.resume.ts](../../packages/oxagen/src/contracts/repo.resume.ts) | api, mcp, cli, agent |
| [sync_repo](repo.sync.md) | [repo.sync.ts](../../packages/oxagen/src/contracts/repo.sync.ts) | api, mcp, cli, agent |

## Repository

| Capability | Contract | Declared surfaces |
| --- | --- | --- |
| [attach_github_installation](repository.installation.attach.md) | [repository.installation.attach.ts](../../packages/oxagen/src/contracts/repository.installation.attach.ts) | api |
| [bind_main_repository](repository.main.bind.md) | [repository.main.bind.ts](../../packages/oxagen/src/contracts/repository.main.bind.ts) | api |
| [get_main_repository](repository.main.get.md) | [repository.main.get.ts](../../packages/oxagen/src/contracts/repository.main.get.ts) | api, mcp |
| [get_repository_tree](repository.tree.get.md) | [repository.tree.get.ts](../../packages/oxagen/src/contracts/repository.tree.get.ts) | api, mcp, cli |
| [link_repository](repository.link.md) | [repository.link.ts](../../packages/oxagen/src/contracts/repository.link.ts) | api, mcp, cli |
| [list_github_installations](repository.installation.candidates.md) | [repository.installation.candidates.ts](../../packages/oxagen/src/contracts/repository.installation.candidates.ts) | api, mcp |
| [list_installation_repositories](repository.installation.list.md) | [repository.installation.list.ts](../../packages/oxagen/src/contracts/repository.installation.list.ts) | api, mcp |
| [list_repositories](repository.list.md) | [repository.list.ts](../../packages/oxagen/src/contracts/repository.list.ts) | api, mcp, cli |
| [open_init_pr](repository.init_pr.open.md) | [repository.init_pr.open.ts](../../packages/oxagen/src/contracts/repository.init_pr.open.ts) | api, mcp, cli |
| [set_production_branch](repository.production_branch.set.md) | [repository.production_branch.set.ts](../../packages/oxagen/src/contracts/repository.production_branch.set.ts) | api, mcp, cli |
| [unlink_repository](repository.unlink.md) | [repository.unlink.ts](../../packages/oxagen/src/contracts/repository.unlink.ts) | api, mcp, cli |

## Router

| Capability | Contract | Declared surfaces |
| --- | --- | --- |
| [get_routing_policy](router.policy.get.md) | [router.policy.get.ts](../../packages/oxagen/src/contracts/router.policy.get.ts) | api, mcp, cli |
| [list_routing_stats](router.stats.list.md) | [router.stats.list.ts](../../packages/oxagen/src/contracts/router.stats.list.ts) | api, mcp, cli |
| [preview_routing_decision](router.decision.preview.md) | [router.decision.preview.ts](../../packages/oxagen/src/contracts/router.decision.preview.ts) | api, mcp, cli |
| [set_routing_policy](router.policy.set.md) | [router.policy.set.ts](../../packages/oxagen/src/contracts/router.policy.set.ts) | api, mcp, cli |

## Run

| Capability | Contract | Declared surfaces |
| --- | --- | --- |
| [bisect_runs](run.bisect.md) | [run.bisect.ts](../../packages/oxagen/src/contracts/run.bisect.ts) | api, mcp |
| [export_run](run.export.md) | [run.export.ts](../../packages/oxagen/src/contracts/run.export.ts) | api |
| [fork_run](run.fork.md) | [run.fork.ts](../../packages/oxagen/src/contracts/run.fork.ts) | api |
| [get_run](run.get.md) | [run.get.ts](../../packages/oxagen/src/contracts/run.get.ts) | api, mcp |
| [get_run_chain](run.chain.get.md) | [run.chain.get.ts](../../packages/oxagen/src/contracts/run.chain.get.ts) | api, mcp |
| [get_run_cost](run.cost.md) | [run.cost.ts](../../packages/oxagen/src/contracts/run.cost.ts) | api, mcp |
| [get_run_frame_body](run.frame_body.get.md) | [run.frame_body.get.ts](../../packages/oxagen/src/contracts/run.frame_body.get.ts) | api, mcp |
| [get_run_proof](run.proof.get.md) | [run.proof.get.ts](../../packages/oxagen/src/contracts/run.proof.get.ts) | api |
| [get_run_transcript](run.transcript.get.md) | [run.transcript.get.ts](../../packages/oxagen/src/contracts/run.transcript.get.ts) | api, mcp |
| [list_recent_runs](run.recent.list.md) | [run.recent.list.ts](../../packages/oxagen/src/contracts/run.recent.list.ts) | api, mcp |
| [list_runs](run.list.md) | [run.list.ts](../../packages/oxagen/src/contracts/run.list.ts) | api, mcp |
| [summarize_run](run.summarize.md) | [run.summarize.ts](../../packages/oxagen/src/contracts/run.summarize.ts) | api |

## Schema

| Capability | Contract | Declared surfaces |
| --- | --- | --- |
| [create_schema_version](schema.version.create.md) | [schema.version.create.ts](../../packages/oxagen/src/contracts/schema.version.create.ts) | api, mcp, cli |
| [delete_schema](schema.delete.md) | [schema.delete.ts](../../packages/oxagen/src/contracts/schema.delete.ts) | agent |
| [delete_schema_label](schema.label.delete.md) | [schema.label.delete.ts](../../packages/oxagen/src/contracts/schema.label.delete.ts) | api, mcp, cli |
| [delete_schema_property](schema.property.delete.md) | [schema.property.delete.ts](../../packages/oxagen/src/contracts/schema.property.delete.ts) | api, mcp, cli |
| [delete_schema_relationship](schema.relationship.delete.md) | [schema.relationship.delete.ts](../../packages/oxagen/src/contracts/schema.relationship.delete.ts) | api, mcp, cli |
| [diff_schema_versions](schema.version.diff.md) | [schema.version.diff.ts](../../packages/oxagen/src/contracts/schema.version.diff.ts) | api, mcp, cli |
| [dispatch_schema_reconcile](schema.reconcile.dispatch.md) | [schema.reconcile.dispatch.ts](../../packages/oxagen/src/contracts/schema.reconcile.dispatch.ts) | api, mcp, cli |
| [export_schema](schema.export.md) | [schema.export.ts](../../packages/oxagen/src/contracts/schema.export.ts) | api, mcp, cli |
| [get_reconcile_status](schema.reconcile.status.md) | [schema.reconcile.status.ts](../../packages/oxagen/src/contracts/schema.reconcile.status.ts) | api, mcp, cli |
| [get_registry_config](schema.registry.config.md) | [schema.registry.config.ts](../../packages/oxagen/src/contracts/schema.registry.config.ts) | api, mcp, cli |
| [get_schema_registry](schema.registry.get.md) | [schema.registry.get.ts](../../packages/oxagen/src/contracts/schema.registry.get.ts) | api, mcp, cli |
| [list_schema_versions](schema.version.list.md) | [schema.version.list.ts](../../packages/oxagen/src/contracts/schema.version.list.ts) | api, mcp, cli |
| [list_schemas](schema.list.md) | [schema.list.ts](../../packages/oxagen/src/contracts/schema.list.ts) | api, mcp, cli, agent |
| [pin_schema_version](schema.version.pin.md) | [schema.version.pin.ts](../../packages/oxagen/src/contracts/schema.version.pin.ts) | api, mcp, cli |
| [recommend_schema](schema.recommend.md) | [schema.recommend.ts](../../packages/oxagen/src/contracts/schema.recommend.ts) | api, mcp, cli, agent |
| [run_schema_chat](schema.chat.md) | [schema.chat.ts](../../packages/oxagen/src/contracts/schema.chat.ts) | api, agent |
| [setup_schema](schema.setup.md) | [schema.setup.ts](../../packages/oxagen/src/contracts/schema.setup.ts) | api, mcp, cli, agent |
| [toggle_schema](schema.toggle.md) | [schema.toggle.ts](../../packages/oxagen/src/contracts/schema.toggle.ts) | api, mcp, cli |
| [upsert_schema_label](schema.label.upsert.md) | [schema.label.upsert.ts](../../packages/oxagen/src/contracts/schema.label.upsert.ts) | api, mcp, cli, agent |
| [upsert_schema_property](schema.property.upsert.md) | [schema.property.upsert.ts](../../packages/oxagen/src/contracts/schema.property.upsert.ts) | api, mcp, cli, agent |
| [upsert_schema_relationship](schema.relationship.upsert.md) | [schema.relationship.upsert.ts](../../packages/oxagen/src/contracts/schema.relationship.upsert.ts) | api, mcp, cli, agent |
| [validate_schema_node](schema.validate.node.md) | [schema.validate.node.ts](../../packages/oxagen/src/contracts/schema.validate.node.ts) | api, mcp, agent, cli |
| [validate_schema_relationship](schema.validate.relationship.md) | [schema.validate.relationship.ts](../../packages/oxagen/src/contracts/schema.validate.relationship.ts) | api, mcp, agent, cli |

## Secret

| Capability | Contract | Declared surfaces |
| --- | --- | --- |
| [delete_secret_key](secret.key.delete.md) | [secret.key.delete.ts](../../packages/oxagen/src/contracts/secret.key.delete.ts) | api, mcp, agent |
| [export_secrets](secret.export.md) | [secret.export.ts](../../packages/oxagen/src/contracts/secret.export.ts) | api, mcp |
| [import_env_secrets](secret.import_env.md) | [secret.import_env.ts](../../packages/oxagen/src/contracts/secret.import_env.ts) | api, mcp, agent |
| [list_secret_keys](secret.key.list.md) | [secret.key.list.ts](../../packages/oxagen/src/contracts/secret.key.list.ts) | api, mcp, agent |
| [reveal_secret](secret.reveal.md) | [secret.reveal.ts](../../packages/oxagen/src/contracts/secret.reveal.ts) | api, mcp |
| [set_secret_value](secret.value.set.md) | [secret.value.set.ts](../../packages/oxagen/src/contracts/secret.value.set.ts) | api, mcp, agent |
| [unset_secret_value](secret.value.unset.md) | [secret.value.unset.ts](../../packages/oxagen/src/contracts/secret.value.unset.ts) | api, mcp, agent |
| [upsert_secret_key](secret.key.upsert.md) | [secret.key.upsert.ts](../../packages/oxagen/src/contracts/secret.key.upsert.ts) | api, mcp, agent |

## Shell

| Capability | Contract | Declared surfaces |
| --- | --- | --- |
| [get_nav_counts](shell.nav_counts.get.md) | [shell.nav_counts.get.ts](../../packages/oxagen/src/contracts/shell.nav_counts.get.ts) | api, mcp |

## Skill

| Capability | Contract | Declared surfaces |
| --- | --- | --- |
| [list_skills](skill.list.md) | [skill.list.ts](../../packages/oxagen/src/contracts/skill.list.ts) | api, mcp |
| [propose_skill](skill.propose.md) | [skill.propose.ts](../../packages/oxagen/src/contracts/skill.propose.ts) | api |

## Spend

| Capability | Contract | Declared surfaces |
| --- | --- | --- |
| [dismiss_finding](finding.dismiss.md) | [finding.dismiss.ts](../../packages/oxagen/src/contracts/finding.dismiss.ts) | api, mcp |
| [export_statement](spend.statement.export.md) | [spend.statement.export.ts](../../packages/oxagen/src/contracts/spend.statement.export.ts) | api, mcp |
| [get_finding_evidence](finding.evidence.get.md) | [finding.evidence.get.ts](../../packages/oxagen/src/contracts/finding.evidence.get.ts) | api, mcp |
| [get_spend](spend.get.md) | [spend.get.ts](../../packages/oxagen/src/contracts/spend.get.ts) | api, mcp |
| [get_spend_drill](spend.drill.md) | [spend.drill.ts](../../packages/oxagen/src/contracts/spend.drill.ts) | api, mcp |
| [list_findings](finding.list.md) | [finding.list.ts](../../packages/oxagen/src/contracts/finding.list.ts) | api, mcp |
| [list_waste](spend.waste.md) | [spend.waste.ts](../../packages/oxagen/src/contracts/spend.waste.ts) | api, mcp |
| [record_finding_fix](finding.fix.record.md) | [finding.fix.record.ts](../../packages/oxagen/src/contracts/finding.fix.record.ts) | api, mcp, agent |

## System

| Capability | Contract | Declared surfaces |
| --- | --- | --- |
| [get_install_instructions](system.install.instructions.md) | [system.install.instructions.ts](../../packages/oxagen/src/contracts/system.install.instructions.ts) | api, mcp, agent |

## Tacho

| Capability | Contract | Declared surfaces |
| --- | --- | --- |
| [create_enrollment_token](tacho.enrollment_token.create.md) | [tacho.enrollment_token.create.ts](../../packages/oxagen/src/contracts/tacho.enrollment_token.create.ts) | api, cli |
| [create_tacho_enrollment](tacho.enrollment.create.md) | [tacho.enrollment.create.ts](../../packages/oxagen/src/contracts/tacho.enrollment.create.ts) | api |
| [enroll_host](tacho.host.enroll.md) | [tacho.host.enroll.ts](../../packages/oxagen/src/contracts/tacho.host.enroll.ts) | api, cli |
| [get_tacho_bundle](tacho.bundle.get.md) | [tacho.bundle.get.ts](../../packages/oxagen/src/contracts/tacho.bundle.get.ts) | api |
| [get_tacho_session](tacho.session.get.md) | [tacho.session.get.ts](../../packages/oxagen/src/contracts/tacho.session.get.ts) | api |
| [ingest_tacho_events](tacho.events.ingest.md) | [tacho.events.ingest.ts](../../packages/oxagen/src/contracts/tacho.events.ingest.ts) | api |
| [list_incidents](tacho.incident.list.md) | [tacho.incident.list.ts](../../packages/oxagen/src/contracts/tacho.incident.list.ts) | api, mcp |
| [list_tacho_hosts](tacho.host.list.md) | [tacho.host.list.ts](../../packages/oxagen/src/contracts/tacho.host.list.ts) | api, mcp |
| [list_tacho_sessions](tacho.session.list.md) | [tacho.session.list.ts](../../packages/oxagen/src/contracts/tacho.session.list.ts) | api |
| [revoke_tacho_enrollment](tacho.enrollment.revoke.md) | [tacho.enrollment.revoke.ts](../../packages/oxagen/src/contracts/tacho.enrollment.revoke.ts) | api |

## Telemetry

| Capability | Contract | Declared surfaces |
| --- | --- | --- |
| `create_stella_enrollment` | [telemetry.stella.enroll.ts](../../packages/oxagen/src/contracts/telemetry.stella.enroll.ts) | api |
| [ingest_stella_operational_telemetry](telemetry.stella.ingest.md) | [telemetry.stella.ingest.ts](../../packages/oxagen/src/contracts/telemetry.stella.ingest.ts) | api |
| [list_error_clusters](telemetry.error.cluster.md) | [telemetry.error.cluster.ts](../../packages/oxagen/src/contracts/telemetry.error.cluster.ts) | api, mcp, agent |

## Tool

| Capability | Contract | Declared surfaces |
| --- | --- | --- |
| [import_tools](tool.import.md) | [tool.import.ts](../../packages/oxagen/src/contracts/tool.import.ts) | api, mcp |
| [list_tool_declarations](tool.declaration.list.md) | [tool.declaration.list.ts](../../packages/oxagen/src/contracts/tool.declaration.list.ts) | api, agent, mcp |
| [list_tool_versions](tool.version.list.md) | [tool.version.list.ts](../../packages/oxagen/src/contracts/tool.version.list.ts) | api, mcp |
| [publish_tool_declaration](tool.declaration.publish.md) | [tool.declaration.publish.ts](../../packages/oxagen/src/contracts/tool.declaration.publish.ts) | api |
| [set_tool_classification](tool.classification.set.md) | [tool.classification.set.ts](../../packages/oxagen/src/contracts/tool.classification.set.ts) | api, mcp |

## Tools

| Capability | Contract | Declared surfaces |
| --- | --- | --- |
| [load_tools](tools.load.md) | [tools.load.ts](../../packages/oxagen/src/contracts/tools.load.ts) | api, mcp, agent |
| [search_tools](tools.search.md) | [tools.search.ts](../../packages/oxagen/src/contracts/tools.search.ts) | api, mcp, agent |

## User

| Capability | Contract | Declared surfaces |
| --- | --- | --- |
| [get_user_budget](budget.policy.read.md) | [budget.policy.read.ts](../../packages/oxagen/src/contracts/budget.policy.read.ts) | api, mcp, agent |
| [get_user_preferences](user.preferences.read.md) | [user.preferences.read.ts](../../packages/oxagen/src/contracts/user.preferences.read.ts) | api, mcp, agent |
| [get_workspace_user_preferences](get_workspace_user_preferences.md) | [user.workspace_preferences.read.ts](../../packages/oxagen/src/contracts/user.workspace_preferences.read.ts) | api, mcp, agent |
| [set_preferences](user.preferences.set.md) | [user.preferences.set.ts](../../packages/oxagen/src/contracts/user.preferences.set.ts) | api, mcp |
| [update_profile](user.profile.update.md) | [user.profile.update.ts](../../packages/oxagen/src/contracts/user.profile.update.ts) | api |
| [update_user_budget](budget.policy.write.md) | [budget.policy.write.ts](../../packages/oxagen/src/contracts/budget.policy.write.ts) | api, mcp, agent |
| [update_workspace_user_preferences](update_workspace_user_preferences.md) | [user.workspace_preferences.write.ts](../../packages/oxagen/src/contracts/user.workspace_preferences.write.ts) | api |

## Workspace

| Capability | Contract | Declared surfaces |
| --- | --- | --- |
| [archive_workspace](workspace.archive.md) | [workspace.archive.ts](../../packages/oxagen/src/contracts/workspace.archive.ts) | api, mcp, agent |
| [create_workspace](workspace.create.md) | [workspace.create.ts](../../packages/oxagen/src/contracts/workspace.create.ts) | api, mcp, agent |
| [get_budget_policy](workspace.budget_policy.read.md) | [workspace.budget_policy.read.ts](../../packages/oxagen/src/contracts/workspace.budget_policy.read.ts) | api, mcp, agent |
| [get_model_settings](workspace.model_settings.read.md) | [workspace.model_settings.read.ts](../../packages/oxagen/src/contracts/workspace.model_settings.read.ts) | api, mcp, agent |
| [get_prompt_settings](prompt.settings.read.md) | [prompt.settings.read.ts](../../packages/oxagen/src/contracts/prompt.settings.read.ts) | api, mcp, agent |
| [get_workspace_settings](workspace.settings.read.md) | [workspace.settings.read.ts](../../packages/oxagen/src/contracts/workspace.settings.read.ts) | api, mcp, agent |
| [list_workspaces](workspace.list.md) | [workspace.list.ts](../../packages/oxagen/src/contracts/workspace.list.ts) | api, mcp, agent |
| [send_workspace_invite](workspace.invite.send.md) | [workspace.invite.send.ts](../../packages/oxagen/src/contracts/workspace.invite.send.ts) | api, mcp |
| [update_budget_policy](workspace.budget_policy.write.md) | [workspace.budget_policy.write.ts](../../packages/oxagen/src/contracts/workspace.budget_policy.write.ts) | api, mcp, agent |
| [update_model_settings](workspace.model_settings.write.md) | [workspace.model_settings.write.ts](../../packages/oxagen/src/contracts/workspace.model_settings.write.ts) | api, mcp, agent |
| [update_prompt_settings](prompt.settings.write.md) | [prompt.settings.write.ts](../../packages/oxagen/src/contracts/prompt.settings.write.ts) | api, mcp, agent |
| [update_workspace_settings](workspace.settings.write.md) | [workspace.settings.write.ts](../../packages/oxagen/src/contracts/workspace.settings.write.ts) | api, mcp, agent |
| [resend_member_invite](org.member_invite.resend.md) | [org.member_invite.resend.ts](../../packages/oxagen/src/contracts/org.member_invite.resend.ts) | api, mcp |
| [revoke_member_invite](org.member_invite.revoke.md) | [org.member_invite.revoke.ts](../../packages/oxagen/src/contracts/org.member_invite.revoke.ts) | api, mcp |

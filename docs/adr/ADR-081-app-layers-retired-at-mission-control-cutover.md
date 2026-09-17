# ADR-081: The `app` layer is retired at the Mission Control cutover for every capability rev1 does not surface

- **Status:** Accepted
- **Date:** 2026-09-16
- **Owners:** platform
- **Related:** `apps/app/ARCHITECTURE.md` §8 (cutover), `apps/app/architecture.worklist.json`
  WL-50, ADR-043 (Oxagen governs agents, it does not run them), `DEREGISTERED.md`
  (de-registered is not deleted), CLAUDE.md "UI Capability Parity is law"

## Context

`layers: ["app"]` on a contract is a promise: a human can operate this capability
in `apps/app`, and `pnpm check:ui-parity --strict` holds us to it by requiring a
binding to a page that exists and works.

The Mission Control rebuild replaced `apps/app` wholesale. The old app moved to
`apps/app_deprecated` and the gates kept reading it (`tools/scripts/lib/app-dir.mjs`)
so the promise stayed true while the new app was built. WL-50 flips `APP_DIR` to
`apps/app`. At that moment 50 capabilities declare `app` and have no page in the
rebuilt app, because rev1 ships eight surfaces and the deprecated app shipped far
more.

Leaving the layer on would make the strict gate fail against promises nothing
keeps. Deleting the capabilities would be wrong: they are de-registered, not
deleted, and their contracts, handlers, routes and tools stay in the tree and
keep working on `api`, `mcp` and `cli`.

## Decision

At the cutover the `app` layer is retired on the 50 capabilities below. Each keeps
every other layer and every other surface. The layer returns when, and only when,
a rev1 page binds it in `apps/app/capability-ui-map.json` with a proof.

Retiring the layer is not de-registering the capability and is not deleting it.
It is the removal of a UI promise that the rebuilt app does not yet make.

| Capability | The lane that restores it |
|---|---|
| `archive_conversation` | the chat surface, which rev1 does not ship (spec §0; the in-app agent is a governed Q&A loop, not a conversation manager) |
| `assign_agent_role` | agent RBAC, which rev1 folds into the Roles page at /[org]/roles; the per-agent role editor is not rebuilt |
| `bind_agent_environment` | environments, de-registered (DEREGISTERED.md) |
| `configure_integration` | the connector catalogue, de-registered with the marketplace (DEREGISTERED.md §1) |
| `delete_conversation` | the chat surface, which rev1 does not ship (spec §0; the in-app agent is a governed Q&A loop, not a conversation manager) |
| `delete_secret_key` | workspace secret keys, not a rev1 surface |
| `demote_memory` | the memory/promotion surface, de-registered with the knowledge pages (DEREGISTERED.md) |
| `dismiss_memory_promotion` | the memory/promotion surface, de-registered with the knowledge pages (DEREGISTERED.md) |
| `get_agent_def` | the agent-definition editor, replaced in rev1 by /[org]/[ws]/agents/[agent]/source over commit_agent_definition |
| `get_agent_role` | agent RBAC, which rev1 folds into the Roles page at /[org]/roles; the per-agent role editor is not rebuilt |
| `get_auth_alerts` | the auth-alerts panel, not a rev1 surface |
| `get_budget_policy` | the budget-policy editor; rev1 ships spend budgets at /[org]/[ws]/spend over get_spend_budget/set_spend_budget |
| `get_capability_registry` | the capability registry browser, not a rev1 surface |
| `get_citation_stats` | the memory/promotion surface, de-registered with the knowledge pages (DEREGISTERED.md) |
| `get_graph_stats` | the graph explorer, de-registered with the knowledge pages |
| `get_model_settings` | model settings, not a rev1 surface |
| `get_node` | no rev1 surface |
| `get_plugin_schema` | the marketplace and plugin catalogue, de-registered in full (DEREGISTERED.md §1) |
| `get_usage_breakdown` | the usage-breakdown page; rev1 ships spend at /[org]/[ws]/spend |
| `get_workspace_user_preferences` | workspace user preferences, not a rev1 surface |
| `install_integration` | the connector catalogue, de-registered with the marketplace (DEREGISTERED.md §1) |
| `install_plugin` | the marketplace and plugin catalogue, de-registered in full (DEREGISTERED.md §1) |
| `install_plugins_bulk` | the marketplace and plugin catalogue, de-registered in full (DEREGISTERED.md §1) |
| `list_agent_environments` | environments, de-registered (DEREGISTERED.md) |
| `list_agent_roles` | agent RBAC, which rev1 folds into the Roles page at /[org]/roles; the per-agent role editor is not rebuilt |
| `list_capability_registry` | the capability registry browser, not a rev1 surface |
| `list_connections` | the connector catalogue, de-registered with the marketplace (DEREGISTERED.md §1) |
| `list_conversations` | the chat surface, which rev1 does not ship (spec §0; the in-app agent is a governed Q&A loop, not a conversation manager) |
| `list_environments` | environments, de-registered (DEREGISTERED.md) |
| `list_notifications` | the notifications centre, not a rev1 surface |
| `list_plugin_registries` | the marketplace and plugin catalogue, de-registered in full (DEREGISTERED.md §1) |
| `list_secret_keys` | workspace secret keys, not a rev1 surface |
| `list_tacho_hosts` | the legacy Fleet read; rev1 renders the fleet at /[org]/[ws] over list_runs and list_incidents |
| `mark_notification` | the notifications centre, not a rev1 surface |
| `purge_conversations` | the chat surface, which rev1 does not ship (spec §0; the in-app agent is a governed Q&A loop, not a conversation manager) |
| `rename_conversation` | the chat surface, which rev1 does not ship (spec §0; the in-app agent is a governed Q&A loop, not a conversation manager) |
| `revise_agent_def` | the agent-definition editor, replaced in rev1 by /[org]/[ws]/agents/[agent]/source over commit_agent_definition |
| `revoke_agent_role` | agent RBAC, which rev1 folds into the Roles page at /[org]/roles; the per-agent role editor is not rebuilt |
| `search_references` | no rev1 surface |
| `set_auth_alerts` | the auth-alerts panel, not a rev1 surface |
| `set_plugin_secret` | the marketplace and plugin catalogue, de-registered in full (DEREGISTERED.md §1) |
| `suggest_commands` | no rev1 surface |
| `suggest_promotion_rationales` | the memory/promotion surface, de-registered with the knowledge pages (DEREGISTERED.md) |
| `unbind_agent_environment` | environments, de-registered (DEREGISTERED.md) |
| `uninstall_plugin` | the marketplace and plugin catalogue, de-registered in full (DEREGISTERED.md §1) |
| `update_budget_policy` | the budget-policy editor; rev1 ships spend budgets at /[org]/[ws]/spend over get_spend_budget/set_spend_budget |
| `update_model_settings` | model settings, not a rev1 surface |
| `update_user_budget` | no rev1 surface |
| `update_workspace_user_preferences` | workspace user preferences, not a rev1 surface |
| `write_memory` | the memory/promotion surface, de-registered with the knowledge pages (DEREGISTERED.md) |

## Consequences

- `pnpm check:ui-parity --strict` passes with `APP_DIR = "apps/app"`: 70 bindings,
  no forward gap.
- Each capability above is still reachable on `api`, `mcp` and `cli`, so nothing a
  customer or an agent can do today stops working.
- A lane that rebuilds one of these surfaces adds `"app"` back and binds it in the
  same PR, exactly as CLAUDE.md's parity rule requires of any new surface.
- The reverse advisory in `check_ui_parity` stays the guard against the opposite
  mistake: a page that invokes a capability whose contract does not declare `app`.

---
# Agent Builder

- **Route:** `/{orgSlug}/{workspaceSlug}/workbench/agents/new` (create) and `/{orgSlug}/{workspaceSlug}/workbench/agents/[agentId]` (edit)
- **Nav location:** workspace → Workbench → tab "Agents" → row click / New agent
- **Priority:** P1
- **Disposition vs today:** Keep + fold in trigger management

## Purpose
The single surface for designing an agent's identity, scope, and equipment: name/prompt, the four equip pools (skills, tools, subagents, MCP servers), environment/template bindings, and — newly — triggers and AI-assisted drafting. It is where the accountability chain (identity → knowledge scope → permitted action) is authored before any run happens.

## Primary user & jobs-to-be-done
- **Primary user:** agent builder / workspace admin
- **JTBD:**
  - Draft a new agent from a plain-language description via AI suggestion
  - Equip an agent with skills, tools, subagents, and MCP servers
  - Bind an environment/sandbox template so runs are reproducible
  - Publish and deploy an agent version once ready
  - Attach triggers (manual/cron/event) so the agent runs on a schedule or signal

## Functionality
- Create mode (`new`): name/description field with "Suggest from description" AI action; 4 equip pools as multi-select panels (Skills / Tools / Subagents / MCP Servers); Save as draft.
- Edit mode (`[agentId]`): same panels pre-populated; read-only for non-managers or already-deployed/managed agents; environment/template binding card (pick from `environment.list`, sandbox template from `sandbox.template.list`).
- Publish / Deploy controls in a header action bar, gated by `canManage`.
- Triggers section (new): list of triggers on this agent with type (Manual / Cron / Event), enabled toggle, create/edit/delete.

## Capabilities invoked
- `agent.definition.create` / `.get` / `.update` / `.publish` — lifecycle.
- `agent.definition.suggest` (`suggest_agent_def`) — AI-assisted draft from description.
- `agent.deploy` (`deploy_agent`) — deploy control.
- `agent.environment.list` / `.bind` / `.unbind` (`list_agent_environment` / `bind_agent_environment` / `unbind_agent_environment`) — environment binding.
- `environment.list` (`list_environments`), `sandbox.template.list` (`list_sandbox_templates`) — binding pickers.
- `agent.trigger.list` / `.create` / `.update` / `.delete` (`list_trigger` / `create_trigger` / `update_trigger` / `delete_trigger`) — trigger management.
- `plugin.org.install` (`install_plugin`) — equip an MCP/tool pack not yet installed.

## Data sources
Postgres (definitions, versions, environment bindings, triggers).

## States
- **Empty:** new agent with no equipment — equip panels show "Nothing equipped yet" with quick-add.
- **Loading:** panel-level skeletons per equip pool so slow pools don't block others.
- **Error:** suggest/publish/deploy failures surface inline near the triggering control, not full-page.

## Existing implementation
- **Today:** `agents/new` and `agents/[agentId]` COMPLETE for equip/edit; environment/template binding card exists. Add: AI-assisted suggest, publish/deploy header controls, and the trigger sub-section.

## Vision alignment
Binds identity → scope → action → terms into the agent definition — the accountability chain at design time, before a single billable action runs.

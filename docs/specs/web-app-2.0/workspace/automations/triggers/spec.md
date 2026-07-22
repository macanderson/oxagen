---
# Triggers

- **Route:** `/{orgSlug}/{workspaceSlug}/automations/triggers`
- **Nav location:** Automations tab strip → "Triggers"
- **Priority:** P2
- **Disposition vs today:** New

## Purpose
A workspace-wide board of every `agent.trigger.*` binding — the manual/cron/event activations configured on individual agents. Today these are only reachable buried inside the trigger editor of a single agent inside Agent Builder (`workbench/agents/[agentId]`); there is no place to see what triggers exist across the whole fleet of agents, which makes runaway or forgotten cron triggers invisible until they misbehave.

## Primary user & jobs-to-be-done
- **Primary user:** workspace admin auditing what can fire autonomously
- **JTBD:**
  - See every agent trigger in the workspace in one table, not one agent at a time
  - Spot which triggers are enabled and when they next fire
  - Create or edit a cron or event binding without opening Agent Builder
  - Disable/delete a trigger that's misfiring

## Functionality
- **Table:** Agent (name, link to Agent Builder), Type (`manual`/`schedule`/`event`), Binding summary (cron expression + timezone, or event source/type/filter), Enabled, Next fire (schedule only).
- **Actions:** Create (pick agent → type → config), Update, Delete, per-row Enable/Disable.
- **Cron editor:** cron expression input with human-readable preview, timezone select.
- **Event editor:** event source, connection binding, filter (key/value record).
- **Contract gap:** `agent.trigger.list` is scoped to one `agentId` per call — there is no workspace-wide list endpoint. This page must first call `agent.definition.list` (`list_agent_defs`) to enumerate agents, then fan out `agent.trigger.list` per agent to assemble the board client-side (or server-side in the page's data loader). A true workspace-scoped `agent.trigger.list` would remove the fan-out; note as a future contract improvement, not a blocker.
- **Cross-link:** each row links to the per-agent trigger editor inside Agent Builder (`workbench/agents/[agentId]`) for the full binding UI.

## Capabilities invoked
- `agent.trigger.list` (`list_triggers`) — per-agent, fanned out across the workspace's agents (enumerated via `agent.definition.list` / `list_agent_defs`).
- `agent.trigger.create` (`create_trigger`).
- `agent.trigger.update` (`update_trigger`).
- `agent.trigger.delete` (`delete_trigger`).

## Data sources
Postgres: `agent_triggers` table (per-agent trigger rows: type, event source/type, connection id, filter, schedule, enabled).

## States
- **Empty:** "No triggers configured across any agent yet."
- **Loading:** skeleton rows while the per-agent fan-out resolves.
- **Error:** partial-failure banner if one agent's `list_triggers` call fails while others succeed — don't blank the whole table.

## Existing implementation
- **Today:** no workspace-wide route. The only UI is the per-agent trigger editor inside Agent Builder. Build new; reuse the Agent Builder trigger-editor components for the create/edit forms instead of re-implementing them.

## Vision alignment
A single audit board for everything that can wake an agent unattended — governed, event/schedule-driven activation is core to the accountability chain (wedge 2); P2 because it's a consolidation/visibility improvement, not a missing capability.

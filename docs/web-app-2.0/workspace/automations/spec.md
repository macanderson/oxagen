---
# Automations

- **Route:** `/{orgSlug}/{workspaceSlug}/automations`
- **Nav location:** workspace → primary → Automations (new top-level sidebar item; tab strip default tab)
- **Priority:** P1
- **Disposition vs today:** New

## Purpose
The management surface for the `automation.*` capability family — playbooks bound to an event, cron, or manual trigger. Today the entire family (create/list/enable/disable/trigger/update) is fully wired at the api/mcp/agent layer and reachable only through chat (inline registry components under `automation-create-inline-*`); there is no dedicated page to see, audit, or govern the automations a workspace has accumulated. This is the single most conspicuous UI gap in the current inventory and the anchor page for the new "Automations" primary nav item.

## Primary user & jobs-to-be-done
- **Primary user:** workspace admin or automation owner
- **JTBD:**
  - See every automation in the workspace, its trigger type, and whether it's live
  - Create a new automation (event, schedule, or manual) without going through chat
  - Enable a configured-but-dormant automation only after explicit human confirmation
  - Disable a misbehaving or noisy automation immediately
  - Fire an automation on demand for testing (`Trigger now`)

## Functionality
- **Table** (Automations tab): columns — Name, Trigger type (`event` / `schedule` / `api`, badge), Enabled (toggle-styled badge), Last fired, Run count. Row click → detail page.
- **Primary actions:** New (opens create form: name, description, trigger type + type-specific config, optional scaffold steps), Enable, Disable, Trigger now (optional JSON payload), Edit (row menu → detail page).
- **In-page tab strip:** Automations · Triggers · Workflows (this page renders the "Automations" tab; the other two are sibling pages under this route).
- **Governance-critical:** Enable always opens a confirm dialog — an automation created by an AI agent is forced to `enabled: false` at creation regardless of input, and only a direct human action against `automation.enable` may flip it live. The Enable button and dialog must never be reachable from an agent-rendered surface.
- **Filters:** trigger type, enabled state, search by name.

## Capabilities invoked
- `automation.list` (`list_automations`) — populate the table.
- `automation.create` (`create_automation`) — New action.
- `automation.enable` (`enable_automation`) — Enable action, behind the confirm dialog.
- `automation.disable` (`disable_automation`) — Disable action.
- `automation.trigger` (`trigger_automation`) — Trigger-now action.
- `automation.update` (`update_automation`) — inline rename/description edit from the row menu.

## Data sources
Postgres (`workflow` schema): `playbooks` (aggregate root), `playbook_triggers` (event/schedule/api binding). Event-triggered automations watch graph node changes in Neo4j (entity type + property-change conditions); schedule triggers are cron, dispatched via Inngest.

## States
- **Empty:** "No automations yet" + New CTA.
- **Loading:** skeleton rows.
- **Error:** inline banner with retry; row-level action failures toast per item.

## Existing implementation
- **Today:** no route exists. `automation.*` is fully wired (api/mcp/agent surfaces) but only reachable via chat's inline creation components (`apps/app/src/components/chat/registry-components/automation-create-inline-*.tsx`). Build new — reuse `PageHeader`/`PageTabs` and the list-page pattern from `knowledge/repos` or `workbench/agents`.

## Vision alignment
Human-gated activation on an otherwise autonomous action is the accountability chain (identity → permitted action → verified outcome) applied to scheduled/event-driven agent work — a direct instance of wedge (2), governance. P1 because the capability is fully built server-side and the missing UI is pure debt.

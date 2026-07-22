---
# Automation

- **Route:** `/{orgSlug}/{workspaceSlug}/automations/[automationId]`
- **Nav location:** reached from Automations list row click
- **Priority:** P2
- **Disposition vs today:** New

## Purpose
The single-automation editor and detail view: configure what fires it, what it does, whether it's live, and what it has done historically. This is where an admin does the real governance work the list page only summarizes — editing trigger conditions, reviewing run history, and toggling enablement behind a human confirmation.

## Primary user & jobs-to-be-done
- **Primary user:** workspace admin who owns or is debugging a specific automation
- **JTBD:**
  - Rename or re-describe the automation
  - Reconfigure its trigger (event conditions on a graph entity/property change, or a cron schedule + timezone)
  - Review its run history with pass/fail outcomes for audit purposes
  - Enable/disable it, always via explicit confirmation
  - Fire it manually with a test payload

## Functionality
- **Header:** name, description (both inline-editable), trigger-type badge, enabled toggle (opens confirm dialog on enable).
- **Trigger config panel:** for `event` — entity type (e.g. `Contact`, `Deal`), event type (`node.created`/`node.updated`/`node.deleted`), property conditions (property, operator `eq`/`gt`/`lt`/`changed`, from/to value); for `schedule` — cron expression + IANA timezone; for `api` — read-only note that it only fires via Trigger-now or the API/MCP/CLI capability.
- **Playbook body:** read-only view of the scaffolded steps (name, step type — `agent`/`tool`/`condition`/`webhook`/`prompt`/`human_input` — and config) set at creation. **Contract gap:** `automation.update` edits name/description/trigger config only — there is no capability to edit steps after creation; step editing needs a new contract (e.g. `automation.steps.update`) before this panel can be made editable. Flag as build-later; ship read-only first.
- **Run history tab:** table from `playbook_events` — timestamp, event type, run outcome, linked `playbook_run_id`.
- **Trigger now:** button + optional JSON payload editor, shows the resulting execution id/status.

## Capabilities invoked
- `automation.update` (`update_automation`) — name/description/trigger-config edits.
- `automation.enable` (`enable_automation`) — behind confirm dialog.
- `automation.disable` (`disable_automation`).
- `automation.trigger` (`trigger_automation`) — Trigger-now.
- `audit.log.query` (`query_audit_log`) — run history, filtered to this playbook's `playbook_events`.

## Data sources
Postgres (`workflow` schema): `playbooks`, `playbook_triggers`, `playbook_runs`, `playbook_events` (append-only, hash-chained audit spine).

## States
- **Empty:** run-history tab shows "Never fired" until first trigger.
- **Loading:** skeleton header + panel.
- **Error:** inline banner; trigger-now failure surfaces the capability's error message inline, not a generic toast.

## Existing implementation
- **Today:** no route. Build new; pairs with the Automations list page (P1) in the same PR family.

## Vision alignment
Every fire, enable, and edit lands in `playbook_events` — the audit-record link of the accountability chain made visible and inspectable per-automation.

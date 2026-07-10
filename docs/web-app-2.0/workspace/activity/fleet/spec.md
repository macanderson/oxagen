---
# Fleet

- **Route:** `/{orgSlug}/{workspaceSlug}/activity/fleet`
- **Nav location:** workspace → primary → Activity → Fleet tab
- **Priority:** P2
- **Disposition vs today:** New

## Purpose
Observability into subagent fan-out: when one agent dispatches many children (parallel research, fan-out review, swarm work), Fleet is where an operator sees the whole fan-out as one unit — its status, its children, their individual costs and outcomes, and any conflicts between them. This entire capability family has zero UI today despite being fully wired at the contract layer.

## Primary user & jobs-to-be-done
- **Primary user:** developer or team lead running multi-agent fan-out workflows
- **JTBD:**
  - See all fan-outs and their status/child-run counts at a glance
  - Drill into one fan-out to see a timeline and every child's status, timing, error, and payload sizes
  - Inspect one child's full input/output payload and logs
  - Cancel an in-progress fan-out that's misbehaving or overspending
  - See a running child's siblings for context on parallel conflicts

## Functionality
- **Fan-out list:** table — columns: label/parent run, status (running/completed/failed/cancelled), child count, started-at, total cost. Row click → fan-out detail.
- **Fan-out detail:** timeline view + per-child row table — columns: capability invoked, status, duration, error (if any), input/output size. Row click → child detail drawer.
- **Child detail:** full input/output payload viewer, "download markdown logfile" action.
- **Siblings view:** from a running child, list its siblings in the same fan-out (for spotting parallel conflicts).
- **Cancel action:** cancel an in-progress fan-out from the list or detail view, with confirmation.

## Capabilities invoked
- `agent.subagent_fanout.list` (`list_subagent_fanouts`) — fan-out list.
- `agent.subagent_fanout.get` (`get_subagent_fanout`) — single fan-out detail + child rows.
- `agent.subagent.aggregate` (`aggregate_subagents`) — rolled-up status/cost across children.
- `agent.subagent_result.get` (`get_subagent_result`) — one child's full payload.
- `agent.subagent.siblings` (`list_subagent_siblings`) — sibling children of a running child.
- `agent.subagent.logs` (`get_subagent_logs`) — child logfile for download.
- `agent.subagent.cancel` (`cancel_subagent`) — cancel an in-progress fan-out/child.

## Data sources
Postgres (fanout and child run rows — operational record); ClickHouse (per-child cost, timing, and lineage events).

## States
- **Empty:** no fan-outs yet in this workspace — explainer pointing at where fan-out is triggered (agent definitions using subagent dispatch).
- **Loading:** skeleton rows for the fan-out list; detail view loads timeline and child table as independent sections.
- **Error:** inline retry per section; cancel action shows a toast on failure without losing the current view.

## Existing implementation
- **Today:** no route exists. All seven capabilities above have contracts, API routes, and MCP tools already — this is a UI-only build. Recommend declaring `app` in `layers[]` for each so `check:manifest`'s reverse-advisory stops flagging them as unwired-in-app.

## Vision alignment
Fleet-scale coordination with typed lineage and per-child metering is a named vision pillar (fleet lineage) with literally no surface today — P2 because the backend is fully wired and this is pure UI debt, not a new capability build.

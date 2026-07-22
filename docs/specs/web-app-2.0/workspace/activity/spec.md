---
# Activity

- **Route:** `/{orgSlug}/{workspaceSlug}/activity`
- **Nav location:** workspace → primary → Activity, with an in-page tab strip: Runs · Fleet · Evals
- **Priority:** P1
- **Disposition vs today:** Keep + add tab strip

## Purpose
The audit trail of everything an agent has done in this workspace: every run, its status, and its cost — the entry point into the accountability chain's "verified outcome" and "audit record" links. Adding the Fleet and Evals tabs here co-locates the whole run/fan-out/quality family under one nav item instead of leaving Fleet unbuilt and Evals an orphan.

## Primary user & jobs-to-be-done
- **Primary user:** workspace member auditing or debugging agent behavior
- **JTBD:**
  - See recent runs at a glance and spot failures quickly
  - Page back through run history without losing place (keyset pagination)
  - Jump into a run's full trace and lineage
  - From the same nav item, reach fleet fan-out observability and eval quality runs

## Functionality
- **Runs tab (default):** table of recent runs — columns: agent/name, status (success/failed/running), started-at, duration, cost, triggering user. Row click → run detail (`/activity/[executionId]`).
- Keyset pagination via `?before=<cursor>` (Older button), no offset pagination.
- **Fleet tab:** links to `/activity/fleet` (see fleet spec).
- **Evals tab:** links to `/evals` (see evals spec) — kept as a tab here for discoverability even though its route stays `/evals` for URL stability.
- No filters today; recommend adding status/agent filters as a fast-follow once the tab strip ships.

## Capabilities invoked
- `agent.execution.list` (`list_executions`) — paginated run list.
- **Reverse-parity note:** this capability powers a real `app` surface today but its contract does not declare `app` in `layers[]` — recommend adding it so `check:manifest` stops flagging it as a false gap.

## Data sources
ClickHouse (execution timing/cost events) joined with Postgres (execution/run metadata) via `agent.execution.list`.

## States
- **Empty:** no runs yet — prompt to go to Ask and run an agent.
- **Loading:** skeleton rows; keyset "Older" button disabled while fetching.
- **Error:** inline retry banner above the table; pagination cursor preserved.

## Existing implementation
- **Today:** `apps/app/src/app/[orgSlug]/[workspaceSlug]/activity/page.tsx` is COMPLETE — recent runs, keyset paginated via `?before=`, each row links to run detail. Build new: the tab strip itself and the Fleet/Evals tab targets (Fleet is wholly new; Evals exists but needs nav wiring, see its own spec).

## Vision alignment
The audit-record end of the governance chain and the first stop for verifying agent runs actually happened as billed — P1 because it is both a complete existing surface and the anchor for fixing two other pages' orphan/missing status.

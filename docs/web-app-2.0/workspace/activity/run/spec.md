---
# Run Detail

- **Route:** `/{orgSlug}/{workspaceSlug}/activity/[executionId]`
- **Nav location:** workspace → primary → Activity → Runs tab → row click
- **Priority:** P1
- **Disposition vs today:** Keep (add a Debug panel for failed runs)

## Purpose
The full trace view of a single agent run — the per-step record that proves what happened and what it cost. This is where the accountability chain's verified outcome and child-run relationships become inspectable.

## Primary user & jobs-to-be-done
- **Primary user:** developer or workspace admin investigating a specific run
- **JTBD:**
  - See the full span tree for a run: steps, tool calls, timings, token/cost per step
  - Inspect tool calls and child executions in the recorded span tree
  - When a run failed, get a structured failure frame instead of raw logs
  - Confirm a run's outcome and cost match what was billed

## Functionality
- **Trace section:** span tree — each span shows name, duration, tokens, cost; nested tool calls expand inline.
- **Debug panel (new):** shown only when `status = failed` — renders `agent.debug.trace`'s structured failure frame (failing step, error type/message, retry count, last good state) above the trace section.
- Friendly not-found state for an invalid/deleted `executionId`.
- Trace and Debug load independently so a slow/failing diagnostic does not block the recorded span tree.

## Capabilities invoked
- `agent.trace.get` (`get_execution_trace`) — span tree with per-step cost/tokens.
- `agent.debug.trace` (`debug_execution`) — structured failure frame, invoked only for failed runs.

## Data sources
ClickHouse (spans, token counts, cost, timings via `agent.trace.get`); `agent.debug.trace` reads the same execution record plus any captured error payload.

## States
- **Empty:** a run with no recorded spans shows an explicit "no trace recorded" state.
- **Loading:** the Trace section has a Suspense boundary; Debug has its own loading skeleton, shown only after status is known to be failed.
- **Error:** friendly not-found page for missing `executionId`; per-section inline error+retry for trace/debug fetch failures.

## Existing implementation
- **Today:** `apps/app/src/app/[orgSlug]/[workspaceSlug]/activity/[executionId]/page.tsx` provides the span-tree trace and friendly not-found state. Add the Debug panel wired to `agent.debug.trace`, conditionally rendered on `status=failed`.

## Vision alignment
Per-step cost plus a replayable span tree makes the accountability chain concrete at the single-run level and provides a direct proof point for the billing/audit story.

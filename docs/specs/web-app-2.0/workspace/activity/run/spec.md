---
# Run Detail

- **Route:** `/{orgSlug}/{workspaceSlug}/activity/[executionId]`
- **Nav location:** workspace → primary → Activity → Runs tab → row click
- **Priority:** P1
- **Disposition vs today:** Keep (add a Debug panel for failed runs)

## Purpose
The full trace + lineage view of a single agent run — the per-step record that proves what happened, what it touched, and what it cost. This is where the accountability chain's "verified outcome" becomes inspectable, and where fleet lineage (which files/sources a run touched) is grounded in the graph.

## Primary user & jobs-to-be-done
- **Primary user:** developer or workspace admin investigating a specific run
- **JTBD:**
  - See the full span tree for a run: steps, tool calls, timings, token/cost per step
  - See which source files/entities the run touched (lineage graph)
  - When a run failed, get a structured failure frame instead of raw logs
  - Confirm a run's outcome and cost match what was billed

## Functionality
- **Trace section:** span tree — each span shows name, duration, tokens, cost; nested tool calls expand inline.
- **Lineage section:** graph view of `:Execution → :SourceFile` (and related entity) edges the run touched, rendered via the shared graph citation components (`NodeRef`, not raw ids).
- **Debug panel (new):** shown only when `status = failed` — renders `agent.debug.trace`'s structured failure frame (failing step, error type/message, retry count, last good state) above the trace section.
- Friendly not-found state for an invalid/deleted `executionId`.
- Both Trace and Lineage load as independent Suspense sections so one slow/failing section doesn't block the other.

## Capabilities invoked
- `agent.trace.get` (`get_execution_trace`) — span tree with per-step cost/tokens.
- `agent.execution.lineage` (`get_execution_lineage`) — file/entity touch graph for the run.
- `agent.debug.trace` (`debug_execution`) — structured failure frame, invoked only for failed runs.

## Data sources
ClickHouse (spans, token counts, cost, timings via `agent.trace.get`); Neo4j (`:Execution`→`:SourceFile`/entity lineage edges via `agent.execution.lineage`); `agent.debug.trace` reads the same ClickHouse execution record plus any captured error payload.

## States
- **Empty:** a run with no lineage edges yet (e.g. a pure-chat run) shows "no file/entity touches recorded" rather than an empty graph canvas.
- **Loading:** two independent Suspense boundaries (trace, lineage); Debug panel has its own loading skeleton, shown only after status is known to be failed.
- **Error:** friendly not-found page for missing `executionId`; per-section inline error+retry for trace/lineage/debug fetch failures.

## Existing implementation
- **Today:** `apps/app/src/app/[orgSlug]/[workspaceSlug]/activity/[executionId]/page.tsx` is COMPLETE — span-tree trace (`trace-section.tsx`) + file-touch lineage graph (`lineage-section.tsx`), two Suspense sections, friendly not-found. Add: the Debug panel wired to `agent.debug.trace`, conditionally rendered on `status=failed`.

## Vision alignment
Per-step cost plus lineage is the accountability chain and fleet-lineage pillars made concrete at the single-run level — P1 because it is both fully built today and a direct proof point for the billing/audit story.

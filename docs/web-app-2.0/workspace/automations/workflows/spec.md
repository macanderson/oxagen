---
# Workflows & swarms

- **Route:** `/{orgSlug}/{workspaceSlug}/automations/workflows`
- **Nav location:** Automations tab strip → "Workflows"
- **Priority:** P3
- **Disposition vs today:** New

## Purpose
The launch and monitoring surface for parallel-orchestration runs: `workflow.*` decomposes one large goal into N concurrent sub-tasks dispatched via Inngest, and `research.swarm.*` fans out diverse web-search variations as concurrent subagent tasks. Neither family has any UI today — both are agent/api/mcp-only capabilities whose only current surface is a chat-rendered `workflow-progress` component. This page gives them a persistent home, and a launch path that doesn't require going through chat.

## Primary user & jobs-to-be-done
- **Primary user:** developer or analyst running large parallel research/processing jobs
- **JTBD:**
  - Launch a workflow by describing a goal, output format, and max parallelism
  - Launch a research swarm by topic, depth, and max parallel searches
  - See a list of past and in-flight runs with progress and status
  - Drill into one run's live sub-task progress
  - Cancel a run that's misbehaving or overspending
  - Jump to the Fleet view for full lineage/cost detail on the underlying fan-out

## Functionality
- **Table** (Workflows tab, plus a Swarms sub-tab or type filter): Goal/Topic, Sub-task count, Progress (%), Status (`planning`/`running`/`complete`/`cancelled`/`error`), Started, Duration.
- **Launch dialog:** Workflow — goal (text, ≤2000 chars), optional title, output format (`json`/`csv`), max parallelism (1–100, default 50). Swarm — topic (≤500 chars), depth (`shallow`/`medium`/`deep`), max parallel (1–20), target knowledge-node label.
- **Detail drawer/page:** live sub-task progress (reuses the chat `workflow-progress` render component outside chat), per-child status via `agent.subagent.dispatch`/`aggregate` results, Cancel action.
- **Cross-link:** every launched run is a subagent fan-out — link out to `activity/fleet` for the full lineage timeline, per-child cost, and payload inspection instead of duplicating that view here.

## Capabilities invoked
- `workflow.run` (`run_workflow`) — launch; returns an `agent_executions` row (`origin_type=workflow_run`) and a `workflow-progress` render spec.
- `workflow.status` (`get_workflow_status`) — poll/detail.
- `workflow.cancel` (`cancel_workflow`).
- `research.swarm.start` (`start_research_swarm`) — launch a swarm.
- `research.swarm.status` (`get_research_status`) — poll swarm progress.
- `agent.subagent.dispatch` (`dispatch_subagent`) / `agent.subagent.aggregate` (`aggregate_subagents`) — underlying fan-out primitives both families are built on.

## Data sources
Postgres: `agent_executions` (workflow run root), Inngest job state. ClickHouse: per-step cost and duration for lineage/billing rollups surfaced on the Fleet view.

## States
- **Empty:** "No workflows or swarms yet" + Launch CTA.
- **Loading:** skeleton rows; detail view shows an indeterminate progress bar until the first sub-task reports.
- **Error:** failed launch shows the capability's validation error inline; a run that errors mid-flight shows its status badge as `error` with a link to the failing child in Fleet.

## Existing implementation
- **Today:** no dedicated route; both families are `agent`-surface capabilities today (no `app` in `workflow.run`'s `surfaces[]`) rendered only via the chat `workflow-progress` component. Build new — this is the first non-chat surface for either family.

## Vision alignment
Fan-out with typed lineage and per-step cost is vision pillar 5 (fleet lineage) made operable outside chat — every step already emits lineage + metering through `invoke()`; P3 because the underlying primitives exist but a dedicated launch/monitor UI needs product sequencing behind Automations/Triggers.

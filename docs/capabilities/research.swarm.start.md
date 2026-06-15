# research.swarm.start

**Domain:** research
**Mode:** async
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** medium

## Intent

Fan out parallel web searches for a topic, generate diverse query variations,
and dispatch them as concurrent subagent tasks. Returns a swarmId to poll via
research.swarm.status.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| topic | string | The research topic to investigate (1-500 chars) |
| depth | enum | Research depth: "shallow" (3 searches), "medium" (8), "deep" (15) (default: "medium") |
| maxParallel | number | Max concurrent search tasks: 1-20 (default: 5) |
| targetLabel | string | KnowledgeNode label for top-level nodes created (default: "Topic") |
| searchDepth | enum | Search depth mode for web.search: "basic" or "advanced" (default: "basic") |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| swarmId | string | Unique ID for this swarm — pass to research.swarm.status |
| dispatchId | string | Subagent fanout dispatch ID from agent.subagent.dispatch |
| status | literal | Always "running" initially |
| estimatedTasks | number | Number of search tasks dispatched |

## Side effects

Creates swarm record in Postgres. Delegates to agent.subagent.dispatch to queue
parallel search tasks via Inngest. ClickHouse telemetry events.

## Errors

None explicitly defined in the contract.

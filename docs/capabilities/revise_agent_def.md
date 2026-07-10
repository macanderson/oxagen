# revise_agent_def

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** medium

## Intent

AI-driven edit of an **existing** agent definition — the edit counterpart to
`suggest_agent_def` (AI-create). Takes a plain-language description of the change
you want plus the agent's current config, has the model design the revised
configuration (identity, instructions, graph access, tools, triggers) grounded in
the same workspace candidates and `create-agent` skill as suggest, then persists
the repaired config as a **new unpublished version** by composing
`update_agent_def` (which bumps the version number).

The agent's **slug is immutable** and is never changed. Publishing stays a
separate explicit step (`publish_agent_def`), so a revision never silently
changes what is live. Product-managed (built-in) agents are read-only and cannot
be revised.

## Input

| Field | Type | Notes |
|---|---|---|
| `agentId` | `string` | Agent public id (`agt_…`), UUID, or slug of the agent to revise. |
| `prompt` | `string` (10–4000) | Plain-language description of the change to make, e.g. `give it read access to the billing ontology and equip the github MCP server`. |

## Output

| Field | Type | Notes |
|---|---|---|
| `agentId` | `string` | Public id (`agt_…`) of the revised agent. |
| `version` | `number` | The newly-created (bumped) version number. |
| `isPublished` | `boolean` | Always `false` — revise snapshots a new unpublished version. |
| `rationale` | `string` | Why the model made these changes. |
| `changeSummary` | `string[]` | Short bullets of what changed versus the prior version (diff line). |
| `warnings` | `string[]` | Non-fatal validation adjustments (e.g. a hallucinated tool ref that was removed). |
| `recommendations` | `{ kind, ref, name, reason }[]` | Tools the agent should have that are not available yet — catalog MCP servers to connect, or disabled skills to enable. Never equipped automatically. |

## Roles

Org Owner, Org Admin, Workspace Owner, Workspace Member.

## Side effects

- LLM: a model call designs the revised configuration (metered via `@oxagen/ai`).
- Database: inserts a new `agent_versions` row (`is_published = false`) at `version = max + 1` via `update_agent_def`. The prior versions are never modified.

## Errors

| code | meaning |
|---|---|
| `agent_revise_failed` | Agent not found, or the agent is product-managed (read-only). |
| `agent_suggest_failed` | Model synthesis failed, or the synthesised config failed validation. |
| `validation_error` | Input failed Zod parse. |
| `unauthorized` | Caller lacks the required org/workspace role. |

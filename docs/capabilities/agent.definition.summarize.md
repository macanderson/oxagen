# agent.definition.summarize

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Generate — or refresh — a short, LLM-inferred plain-text description of what an agent does, for display in list views and selectors. The summary is derived from the agent's name, author description, `agentType`, instructions (system prompt), equipped tools, and triggers.

The summary is cached against a SHA-256 checksum of the agent's current version config (the same canonicalization `agent_versions.checksum` uses). On each call the handler recomputes the checksum of the latest version config and compares it to the stored `summary_checksum`:

- **Checksum matches and a summary exists** → the cached summary is returned with **no model call** (unless `force` is set).
- **Checksum differs (config changed since), no summary yet, or `force: true`** → a fast/cheap model call generates a new summary, which is hard-truncated to 256 characters and persisted alongside the checksum it was derived from.

It reads the **latest** version config (max version), so a save always advances the checksum and regenerates — the summary tracks the newest authored intent. The persisted `summary` is surfaced on `agent.definition.list` and `agent.definition.get`.

LLM failure throws a typed `AgentSummarizeError` (stable `.code = "agent_summarize_failed"`). Callers treat it fail-open — a missing summary is never fatal to a list render, and the Studio Agents list/create/update paths swallow the error and retry later.

## Input

| Field | Type | Notes |
|---|---|---|
| `agentId` | `string` | Agent public id (`agt_…`), UUID, or slug — workspace-scoped. |
| `force` | `boolean?` | Regenerate even when the cached summary's checksum still matches the current config. Defaults to `false`. |

## Output

| Field | Type | Notes |
|---|---|---|
| `agentId` | `string` | The agent's public id (`agt_…`). |
| `summary` | `string` | Plain-text (≤ 256 char) description of what the agent does and what it works with. No markdown, no quotes. |
| `checksum` | `string` | SHA-256 of the canonical version config the summary was derived from — detects staleness on the next call. |

## Roles

Org Owner, Org Admin, Workspace Owner, Workspace Member.

## Notes

- All LLM calls route through `@oxagen/ai` (`generateObjectFor` + `selectModel({ tier: "fast" })`), so the call is metered, duration-tracked, and prompt-hashed into ClickHouse like every other model call.
- Non-destructive: it only writes the derived `summary` / `summary_checksum` columns on `agent.agents`; it never mutates the agent's config or version history.

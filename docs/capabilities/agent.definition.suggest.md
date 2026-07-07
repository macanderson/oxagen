# agent.definition.suggest

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

AI-assisted agent setup. Turns a plain-language description of what an agent should do into a complete **draft** agent configuration — identity, instructions, graph access, tools, and triggers — shaped exactly like `agent.definition.create` input so it can be reviewed, edited, and saved without reshaping.

Nothing is persisted. The `create-agent` builtin skill drives the synthesis as the system prompt, grounded in the workspace's real skills, ontologies (graph schemas), registered MCP servers, agent-surface capabilities, and existing agents. The model's output is then validated and repaired deterministically in code before it is returned.

Two capability tiers are kept strictly separate: **equip what exists** (`suggestion.config.agentTools` only ever holds refs available in the workspace right now) and **recommend what should be connected** (`recommendations` surfaces catalog MCP servers not yet registered and disabled workspace skills, so the caller connects/enables them first, then equips them in a follow-up edit). A recommendation is never placed in `agentTools`.

## Input

| Field | Type | Notes |
|---|---|---|
| `description` | `string` (10–4000) | Plain-language description of the agent's job, what starts it, and what it may touch. |
| `nameHint` | `string?` | Optional preferred slug (lowercase kebab-case). The model derives one when omitted. |
| `agentTypeHint` | `string?` | Optional agentType to steer toward (e.g. `"code"` for a repo-capable agent). |

## Output

| Field | Type | Notes |
|---|---|---|
| `suggestion.slug` | `string` | Lowercase kebab-case slug, capped at 18 chars (so the global agent key `org_ns.workspace_ns.slug` stays ≤ 32) and de-conflicted against existing agents. |
| `suggestion.name` | `string` | Human-readable name. |
| `suggestion.description` | `string` | One-sentence routing description. |
| `suggestion.agentType` | `string` | `"code"` for repo-capable agents, else `"custom"`. |
| `suggestion.config` | `object` | Versioned body — `graph`, `agentTools`, `triggers`, `instructions` (shaped exactly like `agent.definition.create` input). |
| `rationale` | `string` | Why the model chose this configuration. |
| `warnings` | `string[]` | Non-fatal repairs made during validation (dropped tool refs, substituted ontology, de-conflicted slug, clamped over-long slug, moved an already-available recommendation into `agentTools`, etc.). |
| `recommendations` | `{ kind, ref, name, reason }[]` | Tools the agent should have but the workspace lacks — `kind: "mcp_server"` catalog servers (ref = registry name) or `kind: "skill"` disabled workspace skills (ref = slug), each with a description-anchored `reason`. Never included in `agentTools`. Defaults to `[]`. |

## Roles

Org Owner, Org Admin, Workspace Owner, Workspace Member.

## Behavior

- Loads the `create-agent` skill body as the system prompt (tenant copy first, builtin filesystem fallback).
- Assembles two candidate tiers. **Equipable:** enabled skills (`agent.skill.list`), ontologies (`schema.list`), registered MCP servers (`agent.mcp.list`), agent-surface capabilities, and active agents (`agent.definition.list`). **Connectable (recommend-only):** catalog MCP servers not registered in the workspace (`plugin.catalog.browse`, `pluginType: "mcp_server"`, `installed: false`) and disabled workspace skills (`skill.workspace.list`, joined to `agent.skill.list` by name to recover each slug). Disabled skills are excluded from the equipable skill list. Every source degrades to empty on failure, so one unavailable source never fails the suggestion.
- Calls the model (`generateObjectFor`, temperature 0.3) to synthesise a configuration plus recommendations.
- Repairs the synthesis deterministically: drops `agentTools` whose ref is not a real workspace candidate (one warning each), forces every trigger `enabled: false`, drops structurally-invalid triggers, substitutes an out-of-workspace `graph.ontologyId` with the first workspace ontology (or leaves it unbound when the workspace has none), clamps a slug over 18 chars, and de-conflicts a colliding slug within the 18-char budget.
- Validates `recommendations`: drops any whose ref is in neither connectable list (one warning each); a ref that is actually already available (a registered MCP server or an enabled skill) is moved into `agentTools` with a warning rather than recommended; duplicates are collapsed.
- Parses the final config through `agentDefinitionConfigSchema` as the last gate.

## Side effects

- ClickHouse: emits `token_usage` telemetry for the model call (surface, provider, prompt hash, duration). No Postgres or Neo4j writes — the suggestion is not persisted.

## Errors

| code | meaning |
|---|---|
| `validation_error` | Input failed Zod parse (e.g. description under 10 chars, bad `nameHint`). |
| `unauthorized` | Caller lacks the required org/workspace role. |
| `agent_suggest_failed` | The create-agent skill is unavailable, the model call failed, or the synthesised config failed final validation. |

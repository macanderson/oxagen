# suggest_agent_def

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

AI-assisted agent setup. Turns a plain-language description of what an agent should do into a complete **draft** agent configuration — identity, instructions, graph access, and tools — shaped exactly like `create_agent_def` input so it can be reviewed, edited, and saved without reshaping.

Nothing is persisted. The `create-agent` builtin skill drives the synthesis as the system prompt, grounded in the workspace's real skills, ontologies (graph schemas), registered MCP servers, agent-surface capabilities, and existing agents. The model's output is then validated and repaired deterministically in code before it is returned.

Two capability tiers are kept strictly separate: **equip what exists** (`suggestion.config.agentTools` only ever holds refs available in the workspace right now) and **recommend what should be connected** (`recommendations` surfaces catalog MCP servers not yet registered and disabled workspace skills, so the caller connects/enables them first, then equips them in a follow-up edit). A recommendation is never placed in `agentTools`.

## Input

| Field | Type | Notes |
|---|---|---|
| `description` | `string` (10–4000) | Plain-language description of the agent's job, what starts it, and what it may touch. |
| `nameHint` | `string?` | Optional preferred slug (lowercase kebab-case). The model derives one when omitted. |
| `agentTypeHint` | `string?` | Optional agentType to steer toward (for example, `"custom"`). |

## Output

| Field | Type | Notes |
|---|---|---|
| `suggestion.slug` | `string` | Lowercase kebab-case slug, capped at 18 chars (so the global agent key `org_ns.workspace_ns.slug` stays ≤ 32) and de-conflicted against existing agents. |
| `suggestion.name` | `string` | Human-readable name. |
| `suggestion.description` | `string` | One-sentence routing description. |
| `suggestion.agentType` | `string` | The suggested agent type. |
| `suggestion.config` | `object` | Versioned body — `graph`, `agentTools`, `instructions` (shaped exactly like `create_agent_def` input). |
| `rationale` | `string` | Why the model chose this configuration. |
| `warnings` | `string[]` | Non-fatal repairs made during validation (dropped tool refs, substituted ontology, de-conflicted slug, clamped over-long slug, moved an already-available recommendation into `agentTools`, etc.). |
| `recommendations` | `{ kind, ref, name, reason }[]` | Tools the agent should have but the workspace lacks — `kind: "mcp_server"` catalog servers (ref = registry name) each with a description-anchored `reason`. Never included in `agentTools`. Defaults to `[]`. |
| `suggestedRole` | `{ roleName, reason }?` | **Optional, additive.** The narrowest system agent role that can still run the drafted definition, plus the provenance line explaining why not something narrower. `roleName` is one of `"Agent Observer"` / `"Agent Contributor"` / `"Agent Operator"` — never a custom role (the spec's back-compat `Agent Legacy` role does not exist in this build; see §6 Q1). Omitted callers are unaffected; a consumer that ignores the field behaves exactly as before. |

### How `suggestedRole` is derived

`packages/handlers/src/lib/agent-role-suggest.ts` selects the narrowest system
role for the repaired graph and tool configuration. It reads the same role
specifications and capability metadata used by the IAM seeder and resolver.

Agent definitions have no trigger fields. The handler passes `triggerTypes: []`,
so the suggestion uses the attended interpretation. It does not infer that an
agent runs unattended from a schedule or event in the draft.

The suggestion is advisory. `assign_agent_role` checks assignability and the
delegation ceiling when you attach a role. Creating an agent attempts to assign
the default agent role when that role is seeded in the org.

## Roles

Org Owner, Org Admin, Workspace Owner, Workspace Member.

## Behavior

- Builds the authoring prompt from `packages/handlers/src/agent-suggest-core.ts`.
- Loads enabled ontology schemas, registered MCP servers, agent-surface capabilities, existing agent slugs, and the inherited memory policy. Candidate lookups have fallback values when a source fails.
- Separates catalog MCP servers into recommendations. A server must be connected before it can be equipped.
- Calls `generateObjectFor` to draft the configuration and recommendations.
- Repairs tool references and ontology bindings against the available candidates. Clamps the slug to 18 characters and resolves collisions with existing agent slugs.
- Validates recommendations and the final configuration. Returns repair warnings with the draft.
- Derives `suggestedRole` from the repaired configuration.

## Side effects

- ClickHouse: emits `token_usage` telemetry for the model call (surface, provider, prompt hash, duration). No Postgres or Neo4j writes — the suggestion is not persisted.

## Errors

| code | meaning |
|---|---|
| `validation_error` | Input failed Zod parse (e.g. description under 10 chars, bad `nameHint`). |
| `unauthorized` | Caller lacks the required org/workspace role. |
| `agent_suggest_failed` | The create-agent skill is unavailable, the model call failed, or the synthesised config failed final validation. |

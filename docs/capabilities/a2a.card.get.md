# a2a.card.get

**Domain:** a2a
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Read the current workspace's A2A (Agent2Agent) protocol Agent Card — the
discovery document advertising the workspace's exposed agents as A2A skills,
its JSON-RPC transport endpoint (`/a2a`), and its authentication scheme (HTTP
Bearer workspace API key). This is the governed, metered management surface for
the card; the unauthenticated discovery document is served separately at
`/.well-known/agent-card.json`, and the JSON-RPC transport itself lives at
`POST /a2a` (both mounted like `/mcp`, outside the org/workspace path group).

Skills on the card are derived from the workspace's active agent definitions
plus a baseline general-purpose conversational skill.

**Addressing a skill.** Each listed skill's `id` is the agent's slug. A caller
addresses that agent on `message/send`/`message/stream` by putting the slug in
`message.metadata.skillId`; the task then runs with that agent's active-version
`instructions` layered over the generic chat baseline instead of the generic
prompt alone. An unknown or since-deactivated `skillId` (status/deploymentStatus
no longer `active`) falls back to the generic baseline rather than erroring —
the same gate this capability uses to decide whether to list the skill at all.
Every resulting task is recorded as an `agent_executions` row (`originType:
'a2a'`), with `parentExecutionId` chained from `message.referenceTaskIds[0]`
when the caller references a prior task, so `agent.trace.get` renders full A2A
conversation chains. See `docs/specs/a2a-agent-identity/spec.md`.

## Input

| Field     | Type      | Notes                                                                                             |
| --------- | --------- | ------------------------------------------------------------------------------------------------- |
| `baseUrl` | `string?` | Override the public base URL used to build the card's service endpoint. Defaults to `A2A_PUBLIC_URL` (or the production API URL). API callers pass the live request origin. |

## Output

The full A2A `AgentCard`: `{ protocolVersion, name, description, url,
preferredTransport, version, provider, capabilities, defaultInputModes,
defaultOutputModes, skills[], securitySchemes, security, supportsAuthenticatedExtendedCard }`.

## Side effects

None — read-only against the workspace's `agent.agents` table.

## Errors

None expected beyond auth / scope failures handled by middleware.

## SPEC references

- A2A protocol v1.0 (JSON-RPC binding) — https://a2a-protocol.org/

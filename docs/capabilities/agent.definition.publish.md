# agent.definition.publish

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** medium

## Intent

Publish an agent version. Marks the version `isPublished`, computes a SHA-256 checksum over its canonical config, and sets it as the agent's active version. A published version is immutable thereafter.

## Input

| Field | Type | Notes |
|---|---|---|
| `agentId` | `string` | Agent public id (`agt_…`) or UUID. |
| `version?` | `number` (positive int) | Version number to publish. Omit to publish the latest. |

## Output

| Field | Type | Notes |
|---|---|---|
| `agentId` | `string` | Echoes the target agent id. |
| `version` | `number` (positive int) | The published version number. |
| `checksum` | `string` | SHA-256 checksum over the canonical config. |
| `activeVersionId` | `string` | Id of the version now marked active. |

## Roles

Org Owner, Org Admin, Workspace Owner, Workspace Member.

## Side effects

- Postgres: updates the `agent_versions` row (`isPublished`, checksum) and points the agent's active version at it.
- ClickHouse: emits an `agent.definition.published` audit/telemetry event.

## Errors

| code | meaning |
|---|---|
| `not_found` | No agent or version matches the input in this workspace. |
| `validation_error` | Input failed Zod parse. |
| `unauthorized` | Caller lacks the required org/workspace role. |

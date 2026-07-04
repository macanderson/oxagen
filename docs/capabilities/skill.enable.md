# skill.enable

**Domain:** skill
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Enable or disable a skill in the workspace. Disabled skills are hidden from the agent and excluded from tool materialization, but their versions and data are preserved.

## Input

| Field | Type | Notes |
|---|---|---|
| `skill_id` | `string` | Public ID of the skill (`skl_…`) or its slug. |
| `enabled` | `boolean` | `true` to enable, `false` to disable. |
| `workspace_id?` | `string` | Workspace ID (defaults to current workspace). |

## Output

| Field | Type | Notes |
|---|---|---|
| `skill_id` | `string` | Public ID of the skill. |
| `slug` | `string` | Skill slug. |
| `enabled` | `boolean` | New enabled state. |

## Roles

Org Owner, Org Admin, Workspace Owner, Workspace Admin.

## Side effects

- Postgres: updates the skill's enabled flag in the workspace.

## Errors

| code | meaning |
|---|---|
| `not_found` | No skill matches `skill_id` in this workspace. |
| `unauthorized` | Caller lacks the required org/workspace role. |

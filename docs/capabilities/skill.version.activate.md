# skill.version.activate

**Domain:** skill
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp
**Risk level:** medium

## Intent

Set the active version for a skill by re-pointing `skills.active_version_id` to a chosen `skill_versions` row. Can activate any version including older ones (rollback). Exactly one version is active per skill at any time. Sets `activated_by_user_id` and `activated_at` audit columns on the skill row.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| skillId | string | Public ID of the skill (e.g. `skl_...`) |
| versionNumber | integer (min 1) | Version number to activate |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| skillId | string | Public ID of the skill |
| activeVersionNumber | integer | Version number now active |
| activatedAt | string | ISO 8601 timestamp of activation |

## Side effects

Updates `agent.skills` row: sets `active_version_id`, `activated_by_user_id`, `activated_at`, `updated_at`, `updated_by_user_id`.

## Errors

- `skill not found` — the given `skillId` does not exist within the caller's workspace, has been soft-deleted, or belongs to another workspace (tenant isolation enforced in query).
- `version N not found for skill S` — the given `versionNumber` does not exist for this skill within the tenant's workspace.
- DB errors propagated as-is.

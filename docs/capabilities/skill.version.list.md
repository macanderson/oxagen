# skill.version.list

**Domain:** skill
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp
**Risk level:** low
**Billing gate:** none (noBillingGate: true)

## Intent

Return the time-ordered version history for a workspace skill. Each entry includes version number, active/latest flags, author, and creation timestamp. Useful for auditing changes, selecting a rollback target before calling `skill.version.activate`, or diffing versions.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| skill_id | string | Public skill ID (e.g. `skl_...`) |
| limit | integer (1–100, default 20) | Maximum number of versions to return |
| offset | integer (default 0) | Pagination offset — number of versions to skip |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| skill_id | string | Public ID of the skill |
| versions | array | Time-ordered list, newest first |
| versions[].id | string | Public version ID (`slv_…`) |
| versions[].versionNumber | integer | Monotonically increasing version number |
| versions[].isLatest | boolean | True if this is the highest-numbered version |
| versions[].isActive | boolean | True when this version matches `skills.active_version_id` |
| versions[].createdAt | string (ISO 8601) | When the version was created |
| versions[].createdBy | string \| null | User ID of the author, null if unknown |
| total | integer | Total versions stored for this skill (for pagination) |

## Side effects

None — read-only.

## Errors

- If the `skill_id` does not exist in the caller's workspace (soft-deleted or belongs to another tenant), an empty result `{ versions: [], total: 0 }` is returned rather than an error.
- DB errors propagated as-is.

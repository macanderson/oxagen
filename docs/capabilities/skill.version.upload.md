# skill.version.upload

**Domain:** skill
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp
**Risk level:** medium

## Intent

Upload a new immutable skill version from canonical `skill.toml` content. Creates a new `skill_versions` row with `version_number = max + 1`, marks it as `is_latest`, and sets it as the skill's `active_version_id` by default (unless `activate=false` is passed). Prior version rows are never modified beyond clearing their `is_latest` flag. The content is validated via `canonicalizeSkillArtifact` before any DB writes.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| skill_id | string | Public ID of the skill to add a version to (`skl_…`) |
| content | string (min 1) | Canonical `skill.toml` content |
| activate | boolean (default: true) | Set this version as active immediately |
| workspace_id | string (optional) | Workspace ID (defaults to current workspace) |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| version_id | string | Public ID of the new skill version (`slv_…`) |
| version_number | integer | Monotonically increasing version number |
| skill_id | string | Public ID of the parent skill |
| activated | boolean | Whether this version is now the active version |

## Side effects

- Inserts a new immutable `agent.skill_versions` row with `is_latest = true`.
- Clears `is_latest` on the previous latest version row.
- If `activate = true`: updates `agent.skills` row — sets `active_version_id`, `activated_by_user_id`, `activated_at`, `updated_at`, `updated_by_user_id`.

## Shared codepath

Uses the same `createNewSkillVersion` helper as `skill.edit`. Both are thin wrappers over this shared function in `packages/handlers/src/skill-version-create.ts`.

## Errors

- `skill.version.upload requires an authenticated user` — no authenticated user in context.
- `invalid_skill_artifact` — `content` is not valid TOML, is not `kind = "skill"`, or fails schema validation.
- `skill not found: skl_…` — the given `skill_id` does not exist within the caller's workspace, has been soft-deleted, or belongs to another org/workspace (tenant isolation enforced).
- DB errors propagated as-is.

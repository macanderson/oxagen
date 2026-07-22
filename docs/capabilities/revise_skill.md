# revise_skill

**Domain:** skill
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** medium

## Intent

AI-driven edit of an **existing** skill — the edit counterpart to `author_skill`
(AI-create). Takes a plain-language description of the change you want plus the
skill's current active-version content, has the model redesign the skill artifact
(and description/weight) accordingly, then saves the result as a **new immutable
version** via the shared `createNewSkillVersion` helper — the same version-bump
path `edit_skill` and `upload_skill_version` use.

The skill's **identity (slug) is immutable** and is pinned to the existing value,
so the model can never rename the skill. The new version is **activated by
default**; pass `activate: false` to stage it without going live.

## Input

| Field | Type | Notes |
|---|---|---|
| `skill_id` | `string` | Public ID of the skill to revise (`skl_…`). |
| `prompt` | `string` (10–4000) | Plain-language description of the change, e.g. `tighten the incident-response steps to five bullets and add a rollback section`. |
| `activate?` | `boolean` (default `true`) | Set the new version active immediately. `false` stages it without going live. |
| `workspace_id?` | `string` | Workspace ID (defaults to the current workspace). |

## Output

| Field | Type | Notes |
|---|---|---|
| `skill_id` | `string` | Public ID of the parent skill (`skl_…`). |
| `version_id` | `string` | Public ID of the new skill version (`slv_…`). |
| `version_number` | `number` | The newly-created (bumped) version number. |
| `activated` | `boolean` | Whether this version is now the skill's active version. |
| `content` | `string` | The revised canonical `skill.toml` content. |
| `changeSummary` | `string[]` | Short bullets of what changed versus the prior version (diff line). |

## Roles

Org Owner, Org Admin, Workspace Owner, Workspace Admin.

## Side effects

- LLM: a model call redesigns the skill body (metered via `@oxagen/ai`).
- Database: inserts a new `skill_versions` row at `versionNumber = max + 1`, flips the prior `is_latest` off, and (when `activate`) points `skills.active_version_id` at the new version. Prior versions are never modified beyond clearing `is_latest`.

## Errors

| code | meaning |
|---|---|
| `skill_revise_failed` | Skill not found, has no versions to revise, or model synthesis failed. |
| `validation_error` | Input failed Zod parse, or the synthesised document failed canonical `skill.toml` validation. |
| `unauthorized` | Caller lacks the required org/workspace role. |

# skill.workspace.install

**Domain:** skill
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp
**Risk level:** low

## Intent

Install a skill into a workspace — copies a builtin template (by slug) or a custom uploaded definition into a workspace-owned `agent.skills` row with a `skill_versions` v1 entry (`is_latest=true`, `active_version_id` set to v1). Idempotent on slug: if a skill with the same slug already exists in the workspace, the existing record is returned without modification.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| slug | string? | Slug of a builtin skill template to install (e.g. `summarization`). Mutually exclusive with `custom`; at least one must be provided. |
| custom | object? | Custom skill definition to install. Mutually exclusive with `slug`. |
| custom.name | string | Display name of the custom skill (min 1 char). Used to derive the workspace slug. |
| custom.body | string | Markdown/text body of the custom skill (min 1 char). |
| custom.references | string[]? | Optional reference paths bundled with the custom skill. |
| workspace_id | string? | Workspace ID. Defaults to the current workspace from the auth context. |

Exactly one of `slug` or `custom` must be provided; the handler enforces XOR at runtime.

## Output

| Field | Type | Notes |
| --- | --- | --- |
| publicId | string | Public ID of the installed (or pre-existing) skill row. |
| slug | string | Workspace-scoped slug for the skill. |
| activeVersion | number | Active version number (always 1 for a fresh install). |
| installed | boolean | `true` if a new skill was created; `false` if it already existed (idempotent). |

## Side effects

- Writes a new row to `agent.skills` (workspace-scoped, `source=builtin|tenant`).
- Writes a corresponding `skill_versions` row at `version_number=1`, `is_latest=true`.
- Back-fills `active_version_id` on the skills row.
- Sets `installed_from_slug` for builtin installs to preserve provenance.
- No-ops (reads only) when the slug already exists for the workspace.

## Errors

| Code | When |
| --- | --- |
| 400 | Neither `slug` nor `custom` provided. |
| 404 | `slug` references a builtin template that does not exist in the skill registry. |
| 422 | Input validation failure (empty slug, empty custom name/body). |

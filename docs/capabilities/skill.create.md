# skill.create

**Domain:** skill
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** medium

## Intent

Create a new tenant-authored skill in the workspace. Inserts a `skills` row with `source='tenant'` and an initial version (v1). Returns the skill public ID, slug, and version. Idempotent on slug — if a skill with the same slug already exists, it is returned unchanged.

## Input

| Field | Type | Notes |
|---|---|---|
| `name` | `string` (1–100) | Human-readable name for the skill. |
| `slug` | `string` (1–64, kebab-case) | Unique kebab-case identifier for the skill within this workspace. |
| `description?` | `string` (≤500) | Short description of what the skill teaches the agent. |
| `content` | `string` (1–32000) | Full canonical `skill.toml` content. |
| `activate?` | `boolean` | Set the initial version as active immediately (default `true`). |
| `workspace_id?` | `string` | Workspace ID (defaults to current workspace). |

## Output

| Field | Type | Notes |
|---|---|---|
| `publicId` | `string` | Public ID of the skill (`skl_…`). |
| `slug` | `string` | Kebab-case slug. |
| `activeVersion` | `int > 0` | Active version number (`1` for new). |
| `created` | `boolean` | `true` if newly created, `false` if slug already existed (idempotent). |

## Roles

Org Owner, Org Admin, Workspace Owner, Workspace Admin, Workspace Member.

## Side effects

- Postgres: inserts a `skills` row (`source='tenant'`) and an initial v1 skill version.

## Errors

| code | meaning |
|---|---|
| `validation_error` | Input failed Zod parse (e.g. slug not kebab-case, body empty). |
| `unauthorized` | Caller lacks the required org/workspace role. |

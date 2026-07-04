# skill.author

**Domain:** skill
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** medium

## Intent

Author a new skill from a natural-language prompt. The model synthesises a complete `.skill.md` document (YAML frontmatter + body), validates it, then installs it into the workspace via `skill.workspace.install`. Returns the installed skill's publicId, slug, active version number, the generated body, and whether this was a new install.

## Input

| Field | Type | Notes |
|---|---|---|
| `prompt` | `string` (10–4000) | Natural-language description of what the skill should teach the agent. |
| `nameHint?` | `string` (kebab-case) | Preferred slug for the skill (e.g. `code-review`). The model derives one from the prompt if omitted. |
| `category?` | `string` | Category label (e.g. `engineering`, `writing`, `meta`). |
| `activate?` | `boolean` | Activate the new skill version immediately (default `true`). |
| `workspace_id?` | `string` | Workspace ID to install the skill into (defaults to the current workspace). |

## Output

| Field | Type | Notes |
|---|---|---|
| `publicId` | `string` | Public ID of the installed skill (`skl_…`). |
| `slug` | `string` | Kebab-case slug of the installed skill. |
| `body` | `string` | The generated `.skill.md` content (YAML frontmatter + body). |
| `activeVersion` | `int > 0` | Active version number after installation. |
| `installed` | `boolean` | `true` if a new skill was created, `false` if an identically-slugged skill already existed (idempotent). |

## Roles

Org Owner, Org Admin, Workspace Owner, Workspace Admin, Workspace Member.

## Side effects

- Postgres: inserts a `skills` row and an initial skill version (via `skill.workspace.install`).
- LLM: a model call synthesises the `.skill.md` document (metered via `@oxagen/ai`).

## Errors

| code | meaning |
|---|---|
| `validation_error` | Input failed Zod parse, or the synthesised document failed validation. |
| `unauthorized` | Caller lacks the required org/workspace role. |

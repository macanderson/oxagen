# agent.skill.list

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

List skills available in the active workspace — built-in filesystem
skills from `packages/skills/skills/<slug>/skill.toml` plus tenant-defined
skills from `workflow.prompt_templates`.

## Input

| Field    | Type      | Notes                                                  |
| -------- | --------- | ------------------------------------------------------ |
| `filter` | `string?` | Optional substring matched against name and description. |

## Output

| Field    | Type                                                          | Notes              |
| -------- | ------------------------------------------------------------- | ------------------ |
| `skills` | `Array<{ slug, name, description, source, version }>`         | Skill inventory.   |

`source` is `"builtin"` for filesystem skills, `"tenant"` for DB-backed
skills.

## Side effects

None — read-only against the filesystem registry plus
`workflow.prompt_templates`.

## Errors

None expected beyond auth / scope failures handled by middleware.

## SPEC references

- §3 — skills
- §4 — new capabilities

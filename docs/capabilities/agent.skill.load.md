# agent.skill.load

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Load and register a workspace skill at runtime — resolves the requested version
against a semantic version constraint, validates declared dependencies, and
returns the skill body and any capability slugs parsed from the body.

## Input

| Field          | Type         | Notes                                                                               |
| -------------- | ------------ | ----------------------------------------------------------------------------------- |
| `skillSlug`    | `string`     | Slug of the skill to load.                                                          |
| `version`      | `string?`    | Version constraint: exact integer (`"3"`), caret (`"^2"` = ≥2), tilde (`"~2"` = =2). Omit for latest. |
| `dependencies` | `string[]?`  | Additional skill slugs to pre-validate alongside the primary skill.                 |

## Output

| Field              | Type                               | Notes                                                              |
| ------------------ | ---------------------------------- | ------------------------------------------------------------------ |
| `skillSlug`        | `string`                           | Echoes the requested slug.                                         |
| `loaded`           | `boolean`                          | `true` when the skill was found, enabled, and version matched.     |
| `versionLoaded`    | `number`                           | Integer version actually resolved; `0` when `loaded` is `false`.  |
| `body`             | `string`                           | Skill body markdown; empty string when `loaded` is `false`.       |
| `capabilities`     | `string[]`                         | Capability slugs extracted from `## Capability: <slug>` lines.    |
| `dependencyErrors` | `Array<{ slug, reason }>`          | Validation failures for declared dependencies (non-blocking).     |

## Side effects

None — read-only against the `agent.skills` and `agent.skill_versions` tables.
The runtime caller is responsible for activating the skill; this capability only
resolves and returns its content.

## Errors

- `loaded: false` with a `dependencyErrors` entry when the primary skill is
  not found, is disabled, or no version matches the constraint.
- Per-slug entries in `dependencyErrors` for any `dependencies` slug that is
  not found or is disabled — the primary load still proceeds.

## SPEC references

- §3 — skills
- §4 — new capabilities
- §6 — agent-runtime epic, skill versioning

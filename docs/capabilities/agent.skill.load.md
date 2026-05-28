# agent.skill.load

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** agent
**Risk level:** low

## Intent

Load a skill into the agent's working context for the current turn.
Returns the skill body plus any referenced documents the loader has
resolved lazily.

## Input

| Field             | Type     | Notes                                       |
| ----------------- | -------- | ------------------------------------------- |
| `slug`            | `string` | Skill slug from `agent.skill.list`.         |
| `parentMessageId` | `string` | Chat message that owns the load for audit.  |

## Output

| Field        | Type                              | Notes                                  |
| ------------ | --------------------------------- | -------------------------------------- |
| `slug`       | `string`                          | Echoes the loaded slug.                |
| `body`       | `string`                          | Resolved skill markdown body.          |
| `references` | `Array<{ path, body }>`           | Inlined reference documents, if any.   |

## Side effects

- ClickHouse: emit `agent.skill.loaded` row with `slug` and `parentMessageId`.

## Errors

| code             | meaning                                          |
| ---------------- | ------------------------------------------------ |
| `unknown_skill`  | No skill with that slug in this workspace.       |
| `skill_unreadable` | Filesystem or DB read failure.                 |

## SPEC references

- §3 — skills
- §4 — new capabilities

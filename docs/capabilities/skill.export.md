# skill.export

**Domain:** skill
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp
**Risk level:** low
**Billing gate:** none (noBillingGate)

## Intent

Export the active (or a specified) version of a skill as a downloadable `.skill.md` string. The returned content round-trips through `parseSkill` — it contains the full YAML frontmatter followed by the skill body, exactly as authored.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| skillId | string | Public ID of the skill (`skl_…`) |
| versionNumber | integer? | Version to export; defaults to the active version |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| filename | string | Suggested download filename (e.g. `my-skill.skill.md`) |
| content | string | Full `.skill.md` text (YAML frontmatter + body) |
| versionNumber | integer | The version number that was exported |

## Side effects

Read-only. Queries `agent.skills` and `agent.skill_versions` in Postgres.

## Errors

- `Skill not found: <skillId>` — skill does not exist in the workspace or has been deleted.
- `Version <n> not found for skill <skillId>` — the requested version does not exist.
- `No version found for skill <skillId>` — the skill has no versions at all.

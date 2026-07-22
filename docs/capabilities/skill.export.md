# skill.export

**Domain:** skill
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp
**Risk level:** low
**Billing gate:** none (noBillingGate)

## Intent

Export the active (or a specified) version of a skill as a downloadable canonical `skill.toml` string. The returned content round-trips through `parseArtifactToml` — deterministic field order, LF line endings, one trailing newline — so exporting the same version twice yields byte-identical output.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| skillId | string | Public ID of the skill (`skl_…`) |
| versionNumber | integer? | Version to export; defaults to the active version |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| filename | string | Suggested download filename (`<slug>.toml`, e.g. `my-skill.toml`) |
| content | string | Canonical `skill.toml` text |
| versionNumber | integer | The version number that was exported |

## Side effects

Read-only. Queries `agent.skills` and `agent.skill_versions` in Postgres.

## Errors

- `Skill not found: <skillId>` — skill does not exist in the workspace or has been deleted.
- `Version <n> not found for skill <skillId>` — the requested version does not exist.
- `No version found for skill <skillId>` — the skill has no versions at all.

# skill.version.get

**Domain:** skill
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp
**Risk level:** low
**Billing gate:** none (noBillingGate: true)

## Intent

Fetch a specific version of a workspace skill, returning the canonical `skill.toml` content, the parsed `artifact` projection, graph/file references, and version metadata. Use to inspect or diff a historical version, or to retrieve the content before calling `skill.version.activate` to roll back.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| skill_id | string | Public skill ID (e.g. `skl_...`) |
| version_id | string | Public version ID (e.g. `slv_...`) |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| id | string | Public version ID (`slv_…`) |
| skill_id | string | Public skill ID of the owner |
| versionNumber | integer | Version number within this skill |
| isLatest | boolean | True if this is the highest-numbered version |
| isActive | boolean | True when this version matches `skills.active_version_id` |
| content | string | Canonical `skill.toml` content |
| artifact | object | Parsed and validated `SkillArtifact` projection of `content` |
| referencesPayload | array | Graph node and file references projected from the artifact |
| createdAt | string (ISO 8601) | When the version was created |
| createdBy | string \| null | User ID of the author, null if unknown |

## Side effects

None — read-only.

## Errors

- `Skill not found: <skill_id>` — the given `skill_id` does not exist within the caller's workspace, has been soft-deleted, or belongs to another tenant (tenant isolation enforced in query).
- `Skill version not found: <version_id>` — the given `version_id` does not exist for this skill within the caller's workspace.
- DB errors propagated as-is.

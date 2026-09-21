# skill.propose

**Capability:** `propose_skill`
**Domain:** skill
**Mode:** sync
**Scope:** org + workspace
**Surfaces:** api
**Mutates:** yes
**Billing gate:** skipped (`noBillingGate: true`; a skill write, ARCHITECTURE.md §1.5)

## Intent

Add or replace a governed skill as a pull request against the workspace's main repository (MC spec §10.2, §10.6; Appendix E; ADR-090). A skill is the file `.oxagen/skills/<name>/SKILL.md` with a version and a digest. The call writes no row. It cuts the branch `skills/<name>` from the production branch the repository binding recorded, commits `SKILL.md` and, for an uploaded bundle, the files beside it, and opens the pull request, or lands on the branch's open one. The skill exists when a person merges it.

Six checks run before anything reaches GitHub, and a failed check writes nothing:

1. **Frontmatter**: `name`, `version` and `scope` are present, and `name` matches the directory.
2. **Version**: plain semver, and strictly greater than the version merged today when the call replaces a skill.
3. **Digest**: the canonical bytes (LF line ends) hash to `sha256:<hex>`. The checks cover the submitted bytes. They do not run again at merge. Review subsequent pushes before merging.
4. **Grants**: the frontmatter names no `allowed-tools`, `tools`, `permissions`, `grants`, `tier` or `role`. A skill cannot add a tool or raise a tier.
5. **Secret and PII scan**: the body and every bundle file are scanned for credential shapes and US social security numbers.
6. **Load cost**: the estimated tokens (four characters each) fit the `[search] budget` in `.oxagen/skills.toml`, or 6,000 when the file names none.

The same checks are exported as pure functions from the contract module, so the skill wizard shows their verdicts while the file is still being edited.

## Input

| Field | Type | Notes |
|---|---|---|
| `origin` | `"describe" \| "upload"` | How the file arrived. Recorded on the pull request body. The registry path waits on a skill registry store. |
| `name` | `string` | The skill's directory, lowercase kebab-case, up to 48 characters. A replacement names the existing directory. |
| `body` | `string` | The `SKILL.md` bytes, up to 64 KiB. |
| `files` | `{ path, content }[]` | Up to 16 bundle files, each a relative path inside the skill's directory. Default `[]`. |
| `rationale` | `string?` | What the author described; quoted on the pull request. |

## Output

| Field | Type | Notes |
|---|---|---|
| `name`, `path`, `branch` | `string` | `.oxagen/skills/<name>/SKILL.md` on `skills/<name>`. |
| `repository`, `baseRef` | `string` | The main repository and its production branch. |
| `version` | `string` | From the frontmatter. |
| `replaces` | `string \| null` | The version merged today, or null for a new skill. |
| `digest` | `string` | `sha256:<hex>` of the committed `SKILL.md`. |
| `tokens`, `budget` | `number` | Estimated load cost and the budget it was held against. |
| `checks` | `{ name, passed, code }[]` | The six checks, all passed. |
| `commitSha` | `string` | The last commit on the branch. |
| `pullRequest.number` / `.url` | | Opened by this call, or the one already under review. |

## Roles

Org Owner or Admin, checked by the handler (INV-29) for the signed-in user. An API key carries no user, so the call is refused there.

## Side effects

- GitHub, through the workspace's main repository binding: a branch when absent, one commit per file, one pull request when the branch has none open.

## Surfaces

- `POST /api/v1/{org}/{ws}/skills/propose`
- App: the skill wizard's last step (`apps/app/src/features/create`), opened from Steering · Skills **Add a skill** and from ⌘K **Create**.

## Errors

| code | meaning |
|---|---|
| `forbidden` | No signed-in user (`no_principal`), or the user is not an org Owner or Admin (`org_role_required`). |
| `not_found` | The workspace binds no main repository (`workspace_repository_missing`). |
| `conflict` | A check failed (`skill_check_<name>`: `skill_check_frontmatter`, `skill_check_version`, `skill_check_digest`, `skill_check_grants`, `skill_check_secrets` or `skill_check_load_cost`), or the merged skill has no version to compare against (`skill_merged_unversioned`), or GitHub refused a write (`github_refused`). |

An existing proposal branch is reused only when it has an open pull request into the configured production branch. Otherwise the handler refuses with `proposal_branch_exists`; preserve or remove that branch explicitly before retrying. It never deletes the branch automatically.

The upload preview and submission share a YAML frontmatter reader. Quoted names and semantic versions decode to the same values in both. Duplicate keys, aliases, merge keys, null required values, and permission-grant keys fail validation before submission. YAML loads through a skill-only module, outside the eager kernel and contract registry.

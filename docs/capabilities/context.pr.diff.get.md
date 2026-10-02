# get_context_pr_diff

**Name:** `get_context_pr_diff`
**Domain:** context
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Agent:** Stella finds it with `search_tools` and loads it with `load_tools`. It runs with no approval step (`riskLevel: low`).
**Risk level:** low
**Billing:** `noBillingGate: true`
**Mutates:** no

## Intent

The files a proposal's Context PR changes, each read from GitHub or GitLab now as it is on the production branch and on the pull request's head ([ADR-061](../adr/ADR-061-steering-governance-mode-thresholds-and-the-reflector.md); [ADR-184](../adr/ADR-184-the-registry-follows-the-production-branch.md)). The Context PR page draws the diff from the two texts (#5077). Nothing is stored: the branch is the truth until it merges.

## Input

`{ proposalId: prp_… }`

## Output

| Field | Type | Notes |
| --- | --- | --- |
| `proposalId` | `prp_…` | |
| `state` | `diff \| no_pr \| settled` | `no_pr` before a pull request opens; `settled` once it merged or closed, because its branch is deleted |
| `baseRef` / `headSha` | `string \| null` | The production branch compared against and the head read |
| `files[]` | `{ path, status: added \| modified \| removed, before, after, truncated }` | At most 20 files. `before` is null for an added file and `after` for a removed one. A side longer than 100,000 characters is cut and `truncated` is true |
| `moreFiles` | `boolean` | The pull request changes more files than one answer reads |

## Semantics

The paths come from the host's compare of the branch's current head against the production branch (at most 300 files, refused past it as `too_many_files`). The head is read from the branch now, so a push after the checks ran shows. A merged or closed Context PR answers `settled` with no files.

## Errors

| code | reason |
| --- | --- |
| `not_found` | `proposal_not_found` |
| `not_found` | `workspace_repository_missing` |
| `conflict` | `repository_host_changed` / `too_many_files` / `github_refused` |

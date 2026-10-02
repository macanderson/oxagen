# list_memory_pr_records

List the records one memory PR proposes or archives, each with the memories it cites, for the memory PR review card on the Steering page (#4912). It writes nothing.

**Surfaces:** api, mcp

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/context/steering/memory-prs/records`, returns 200
- MCP: `list_memory_pr_records`
- App: Steering › Proposals › Context PRs, the records of a selected memory PR
- Authentication: org Owner or Admin, or workspace Owner, Member, or Viewer, checked by the handler
- Billing: `noBillingGate: true`
- Not on the agent surface.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| `number` | `int` | The memory PR's number in its steering repository |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| `pull_request` | `{ id, number, url, repository, branch, status, opened_at, settled_at }` | `id` is `mpr_…`. `status` is `open`, `merged`, or `closed` |
| `branch_read` | `boolean` | True when the handler read the open PR's branch |
| `records[]` | `{ action, path, lineage, kind, title, summary, memories, dropped }` | `action` is `propose` or `retire` |
| `records[].memories[]` | `{ id, statement, agent, run, evidence, state }` | The memories the record cites. A retirement cites none |
| `records[].dropped` | `{ commit_sha }` or null | The newest commit on the branch that touched a proposed record's path the branch no longer holds |

## Semantics

The memory PR row lists each record and the memories it cites. While the PR is open, the handler reads its branch on the steering host: a record whose file is there gives its `label` and `description` as `title` and `summary`, and a proposed record whose file is gone was dropped from the PR. A settled PR, a PR on a repository the workspace no longer uses, and a branch the host refuses come back from the row alone, with `branch_read` false, and each record takes its title and summary from its first memory. When the workspace's memory PRs hold the number on more than one repository, the newest one answers. A number no memory PR holds answers `not_found` with reason `memory_pr_not_found`.

The review card in `apps/app/src/features/steering/memory-pr-review.tsx` reads this in lane MEM6 (#4914).

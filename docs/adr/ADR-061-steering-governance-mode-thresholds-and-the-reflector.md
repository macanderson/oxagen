# ADR-061: Steering: governance mode, thresholds, the reflector

- **Status:** Accepted
- **Date:** 2026-09-15
- **Owners:** platform
- **Amended by:** ADR-182 (the registry follows the production branch, so a
  Context PR merged on the host publishes too).
- **Related:** the Mission Control spec `2026-09-11-oxagen-mission-control-spec.md`
  (§9 context records, §10 the repository, steering and Context PRs, App. E
  "Context and steering"), issue #2961 and its scope note of 2026-09-14
  ("keep records → proposals → Context PR; cut effect metrics, retirement
  candidates and promotion thresholds"), ADR-051 (records enter the turn as
  volatile policy), ADR-020 (per-workspace GitHub credentials),
  `apps/app/ARCHITECTURE.md` §1.2 (the Steering page), §3.2 and INV-29
  (roles are checked in handlers), `docs/specs/steering/README.md` (the
  `.oxagen/` layout and the check list), Stella `stella-protocol/src/hash.rs`
  and `stella-records/src/ingest/record.rs` (the record hash and the file
  surface Oxagen reproduces)

## Context

A steering record is published by being merged, never by being saved in the
app (spec §10). The platform holds the registry that mirrors the published
files (`agent.context_records`, `context_record_versions`) and an
append-only hash-chained promotions ledger (`agent.context_promotions`), but
nothing between an agent's observation and that registry: no proposal with
its support, no pull request, no checks, no merge that publishes. Issue
#2961 asks for the slice records → proposals → Context PR and leaves three
decisions to the maintainer, each with a recommendation. The scope note cuts
effect metrics, retirement candidates and promotion thresholds from this
release. This record adopts the recommendations, decides what the cut
leaves undecided, and records where the implementation departs from the
issue's sketch and why.

## Decisions

### 1. Governance mode: `team` by default, the file is the record

A workspace runs under the mode `.oxagen/rules/governance.toml` declares on
the production branch of its repository — `solo`, `team` or `regulated`
(spec §10.2, Stella's `Governance` struct). A workspace with no such file
runs under `team`. The file is read when a Context PR is opened (the mode is
recorded on the proposal, `context_proposals.governance_mode`, for the page
to print) and read again when it is merged, because the mode at merge time is
the one that governs the merge. A file that exists but cannot be read (not
TOML, an unknown mode) refuses the open and the merge with
`governance_unreadable`; it never falls to the default.

No `workspace_settings.governance_mode` cache exists. A cache would need
invalidation on push events this lane does not consume, and the two reads it
saves are two GitHub GETs on a human action.

Who merges under each mode (`context.steering.policy.ts`):

| mode | who merges |
| --- | --- |
| `solo` | any workspace member — org Owner/Admin, workspace Owner/Member — the author included |
| `team` | an org Owner or Admin, or a workspace Owner, other than the author |
| `regulated` | an org Owner or Admin other than the author, recorded on the ledger row as the accountable approver |

`team`'s "code-owner review" (spec §10.3 step 3) is enforced by GitHub's own
branch protection on the merge Oxagen requests; Oxagen's side of it is the
second person. GitHub's refusal (a required review missing) surfaces as
`github_refused` and publishes nothing.

The merge is pinned to the commit the checks ran on. `open_context_pr`
records the PR's head (`head_sha`) when it commits the file and, on a re-run,
re-reads it from GitHub; the checks read the file at that commit and the
check runs are posted to it; once every check passes the row carries the
`record_id` and `record_hash` stamped in that file, and check 6 holds the
file's kind, force, scope and statement to the proposal's, so the registry
row written from the proposal at merge describes the file. The squash merges
every file the head changes, so check 1 also fails a PR that changes any path
besides the record file (GitHub's compare from the production branch to
`head_sha`, both paths of a rename counted). `merge_context_pr` refuses
`head_moved` when GitHub's head is no longer `head_sha` and `base_moved` when
the PR no longer targets the production branch (a re-run of the checks
refuses `base_moved` too), sends that sha with the merge (GitHub answers 409
on a race), and publishes the file at that commit. A PR GitHub already reports merged — an earlier call whose
publication failed — is resumed from its merge commit, so a retry publishes
once and never asks GitHub to merge again.

The branch `context/<lineage>` lives as long as its PR. The merge deletes
it before publishing, and `dismiss_proposal` closes an open PR and deletes
its branch before writing `rejected`; the next proposal on the lineage
branches from the production branch that already holds the squash, so
there is no add/add conflict and no "a pull request already exists" 422.
`open_context_pr` records the branch on the row before it calls GitHub, so a
call that failed after GitHub opened the PR is retried onto that PR, and a
dismissal of that proposal finds the PR on its branch and closes it. Every
proposal on a lineage shares the branch, so a PR found there is a proposal's
only when its body names that proposal (`Proposal \`<id>\``, written by
`prBody`); any other open PR on the branch is refused `lineage_pr_open` and
left open by a dismissal. Every status write names the statuses it moves from and
throws `proposal_<status>` when another call moved the proposal first, so a
dismissal never overwrites a merge and a check run never overwrites a
dismissal. Each check write and the outcome write are also tied to the head
the checks read (`AND head_sha = …`): a re-run that recorded a newer head
wins, and the earlier run is refused `head_moved` before it can mark a
commit it did not check as passed.

The three PR writes — `open_context_pr`, `merge_context_pr`,
`dismiss_proposal` — declare the `api` surface only. The API's bearer path
(`apps/api/src/middleware/auth.ts`), every MCP context
(`apps/mcp/src/context.ts`) and the CLI's token are an API key, which
carries no user. The CLI's `oxagen context propose` records the proposal
(`propose_record`); the PR is opened, checked and merged from Mission
Control.

Amended 2026-09-15 (maintainer decision; apps/app/ARCHITECTURE.md §9):
`open_context_pr`, `dismiss_proposal`, `propose_record` and `append_record`
gate the acting user, the signed-in user or the creator of the API key
(`resolveActingUserId`), on the contract's roles with `assertOrgRole`. A
key with no recorded creator is refused `no_principal`. The author columns
of a proposal and an append stay the signed-in user, null for a key, so a
Context PR still stamps an agent's proposal `inferred`. `merge_context_pr`
keeps its reviewer gate on the signed-in user: an API key is refused
`no_principal` there.

The paragraph as first written: `assertOrgRole` and the merge gate refused
an API-key context with `no_principal` before anything was read, and
`propose_record` and `append_record` checked the contract's roles only when
the call carried a user. Mapping an
API key to its creator for these writes would be a decision of its own,
not taken here.

**`promotions.jsonl` is not written.** Stella's ledger records enforcement
grants (`advisory → blocking`) and retirements, chained by line digest; a
first publication is the file's existence on the production branch. This
lane produces no enforcement grant (it writes no `enforcement.mode = "hard"`)
and no retirement, so it appends nothing to that file. The promotion event
spec §10.3 step 4 names is the `agent.context_promotions` row the merge
appends, and Oxagen honours enforcement grants only from that ledger. The
lane that writes a blocking grant decides the repo-side file.

### 2. Promotion thresholds: cut; every proposal may open a PR

The scope note cuts promotion thresholds, so there is no promoter job and no
`candidate` state. A proposal is created in `proposed` by `propose_record`
or by `append_record` with kind `record_proposal`, carries the support it
cites (runs, agents, appended record ids, evidence links) for a person to
weigh, and may be opened as a Context PR at once. The state machine is

```
proposed → pr_open → checks_running → checks_passed → merged
                                    ↘ checks_failed ↗ (re-run through open_context_pr)
rejected  (dismiss_proposal, from any state but merged)
```

`checks_failed` is added to the issue's list: a failed §10.3 check is a
state the page renders, with every failing check named. "One concern, one
pull request" holds by a partial unique index: at most one proposal per
lineage in an open-PR state.

### 3. The reflector: not in this lane

The reflector (spec §9.1) reads every sealed run through a model to append
`observation` and `context_use_feedback` records. Its consumers are the
promoter (cut) and effect measurement (cut). It ships with the lane that
consumes what it writes. `append_record` is its ingress and exists now.

### 4. Proposal state lives in `agent.context_proposals`, not in the ledger

The issue sketches proposal state as columns on `agent.context_promotions`.
That table is INSERT-only at the grant level and hash-chained; a proposal's
status changes six times. The state machine lives in a new table,
`agent.context_proposals` (RLS `standard`), and a merge appends one ledger
row and points the proposal at it (`promotion_event_id`).

### 5. The record hash is Stella's

`record_hash` is SHA-256 over the RFC 8785 canonical bytes of the record
with `record_hash` removed and every null-valued member stripped
(`packages/run-evidence/src/record-hash.ts`, pinned to Stella's golden
digest). `record_id` is `rec_<slug>_<12 hex>` from a first pass with both
identity fields absent, as `Record::stamp` does. The committed file carries
only members Stella's `Record` struct has, because Stella re-serializes the
typed struct before recomputing the hash; a file Oxagen writes re-verifies
under `stella context validate` and a file Stella wrote re-verifies here
(`context.steering.file.test.ts` recomputes a record Stella stamped).

`constraint_effect` is not a member of Stella's file surface; it is Oxagen
metadata on the proposal and the registry row, and check 6 enforces it
there. `sharing_scope = "workspace"` is what the spec says a main-repo
record carries (§10.2); Stella's file loader accepts `personal`,
`repository` and `organization` today, so a workspace-scoped file needs a
Stella change to validate there (see Consequences).

### 6. The workspace's repository is its GitHub connection

Spec §10.1's repository roles (`main`, `linked`) have no store. The Context
PR targets the repository the workspace's GitHub source connection names
(`source_connections.delivery_config.owner` / `.repo`, connector `github`,
status `connected`) and its default branch as the production branch. A
workspace with no connection is refused with `workspace_repository_missing`.
The lane that binds repository roles replaces this lookup.

### 7. Checks run in the request, one at a time, and GitHub mirrors them

The six checks (`docs/specs/steering/README.md`) are pure functions of the
committed file and the registry. `open_context_pr` runs them in order after
the PR opens, writes each outcome to the proposal before the next starts
(so a poll of `get_context_pr` sees the state machine move), and creates a
completed GitHub check run per check on the head commit. A token without
`checks: write` (an OAuth token, the local PAT) is refused by GitHub with
403; the outcome is recorded on the proposal regardless, and the merge gate
reads the proposal. Every check runs even after a failure.

### 8. The steering version is the ledger length

"The bundle version bumps" (issue, spec §10.3 step 4): the workspace's
steering version is the number of rows in `agent.context_promotions` for the
workspace, which a merge increments by one — Stella's `policy_version` is the
same figure. Delivery into the signed policy bundle (`context.system`,
`tacho.bundle.get.ts`) and into context frames (spec §10.4) reads that
version and belongs to the lane that compiles steering text. ADR-091 landed
the bundle half: the compiled text is part of the bundle etag, so a merge
moves the etag without a counter of its own.

### 9. Metering

None of the nine contracts is a governed action: every one declares
`noBillingGate: true`. Reads are console reads (ADR-052 exclusion 2);
`append_record` is memory; a proposal steers nothing; opening and merging a
Context PR are governance decisions the rev1 metering surface (ADR-055,
`apps/app/ARCHITECTURE.md` §1.5) does not list. Adding them is a commercial
call recorded there, not here.

## Consequences

- Nine capabilities: `list_records`, `get_record`, `append_record`,
  `propose_record`, `list_proposals`, `dismiss_proposal`, `open_context_pr`,
  `get_context_pr`, `merge_context_pr`; routes and docs for all nine, MCP
  tools for the six an API key can call; `oxagen context propose` over
  `propose_record`.
- `agent.context_records` gains `kind`, `force`, `constraint_effect`,
  `sharing_scope`, `statement`, `commit_sha`, `path`, `published_at` (null on
  a record `publish_context_record` published). `agent.context_proposals`
  and `agent.context_appends` are new; the latter is INSERT-only for the
  application role. `steering.published` joins the security event taxonomy.
- `packages/github` gains `createCheckRun`, `mergePullRequest` (pinned to
  a head sha), `closePullRequest` and `deleteBranch`; `getPullRequest`
  carries `mergeCommitSha`.
- A workspace-scoped record file declares `sharing_scope = "workspace"`
  per spec §10.2, which Stella's file-surface `SharingScope` does not accept
  yet. Until Stella adds it (its ledger vocabulary already has `workspace`),
  `stella context validate` on a main-repo record fails on that field;
  Oxagen's own checks and merge are unaffected. Tracked as a Stella change.
  **Amended 2026-09-15 (maintainer decision 16c).** Stella's `SharingScope`
  gains a `workspace` value, matching its ledger vocabulary. Oxagen
  steering records stay workspace-scoped, and `publishedSharingScopeSchema`
  (`packages/oxagen/src/contracts/context.steering.shared.ts:36`) keeps
  `repository` and `workspace`. The change lands in the Stella repository,
  and once it does `stella context validate` accepts a main-repo record.
  Nothing in this tree changes for it.
- `retract_record`, `list_record_effect`, `list_retirement_candidates`, the
  promoter, the effect rollup and the reflector are not built; the
  `archived_at` / `archived_why` columns the issue sketched are not added
  because nothing writes them in this release.

# ADR-297: A run is credited with the commits it made

- **Status:** Accepted
- **Date:** 2026-10-03
- **Owners:** repositories, runs, tacho
- **Decided by:** the maintainer, 2026-10-03, in the commit attribution build
  plan (phase 0)
- **Amends:** ADR-288 (the forge store gains a commit grain under each
  revision) and ADR-292 (a run's change set is the commits it made, not the
  whole diff of each pull request it is linked to).
- **Related:** issue #5445, ADR-188 (which commits are the session's), ADR-095
  (observed and attested facts), ADR-294 (the witness queue),
  `packages/tacho/src/collector/session-changes.ts`,
  `packages/tacho/src/collector/git-lane.ts`,
  `packages/database/src/schema/forge.ts`, the commit attribution spec and
  plan under `initiatives/commit-attribution/` in `oxageninc/roadmap`.

## Context

Oxagen credits code to runs by pull request. `forge.pull_request_runs`
(ADR-288) links a run to a pull request, and the Run page shows each linked
run that pull request's whole diff. Nothing counts the lines a run shipped.

Pull request #5375 shows why that is wrong. It has eight commits, read from
GitHub on 2026-10-03. Five are changes. Three are merges from `origin/main`,
made to clear conflicts, and each merge's diff is other people's work. Every
run linked to #5375 is shown all eight. The spec counted the 12 largest
recently merged pull requests in this repository, and 8 of them carry one to
three merges from main.

GitHub cannot tell the runs apart:

- Every commit on #5375 is authored and committed by one identity,
  `mac@oxagen.sh`, and none carries a trailer.
- This repository squash-merges with the pull request body as the message,
  and deletes the branch. Rebase merges are allowed too. Either way, the
  commit on `main` has a new name that no run made, and a trailer on a branch
  commit would not reach it.

Tacho can tell them apart. Under ADR-188, `sessionCommits` in
`packages/tacho/src/collector/session-changes.ts` already picks out a
session's own commits and leaves out pulled commits and commits from before
the session. The list stays in daemon state (`ownCommits`) and never leaves
the host. The `oxagen:worktree_reconciled` frame carries the changed paths,
`diff_base_sha`, `diff_head_sha`, and one combined patch, but no commits.

## Decision

The commit is the unit a run is credited for. One run makes each commit. A
pull request is the set of commits at one head, which ADR-288 stores as a
revision. Several runs can feed one pull request.

### 1. Tacho records the run when the commit is made

A run is credited with the commits it made. Tacho observes them on the host
under ADR-188's rule, and seals them into the `oxagen:worktree_reconciled`
frame as `session_commits` (section 9). The server stores them (section 2).

This is the only point where the run is known. After a push, the commit
carries an author and a committer, and both can be the same person for every
run. After a merge, the commit on `main` is a new one.

### 2. Four forge tables

Each table has the org mixin and the standard tenant policy, as ADR-288's
tables do. A run is named by its public id (`tse_` or `arun_`). No foreign
key crosses a schema boundary.

| Table | One row per | Key | Filled by |
|---|---|---|---|
| `forge.commits` | workspace and commit | `(org, workspace, provider, host, provider_repository_id, sha)` | the tacho frame, then forge sync |
| `forge.run_commits` | commit | `commit_id`, unique | the tacho frame, a patch id match, the backfill |
| `forge.revision_commits` | revision and commit | `(revision_id, commit_id)` | forge sync, once per head |
| `forge.revision_run_lines` | revision and run | `(revision_id, run_id)` | the attribution function |

- **`forge.commits`** carries `parent_shas`, `kind` (`change` or `merge`),
  `patch_id`, `authored_at`, `committed_at`, `subject`, the file counts and
  the per-file counts, and the commit's own diff in `PR_DIFF_BUCKET` with its
  sha256, stored the way ADR-288 stores a revision's. It is keyed on the
  repository id, not the pull request, so a commit a force-push dropped keeps
  its row.
- **`forge.run_commits`** names the run that made the commit, the source
  (section 8), the ADR-188 test that held, the `tool_use_id` when known, and
  whether the commit holds files the run never wrote. It is unique on the
  commit, so a commit has one run.
- **`forge.revision_commits`** lists the commits at one head, in order. It is
  written once, in the step that records the revision, and never changed,
  because ADR-288 makes a stored revision final. A pull request's commits are
  its latest revision's commits. The witness (ADR-294) certifies a revision,
  so its verdict can name the exact commits and runs it covers.
- **`forge.revision_run_lines`** holds each run's commits, written lines, and
  shipped lines for one revision, with the version of the method that
  computed them. One row with no run holds the lines no run is credited with.

### 3. A merge commit is credited with zero lines

A merge's diff against its first parent is the other branch's work. A merge
is stored with `kind = 'merge'` and listed, so a page can show it, but it is
credited with no lines. Crediting only a merge's conflict resolution, which
`git show --remerge-diff` shows, is left for a later decision.

### 4. A rewritten commit goes to the run that made the original

A rebase, an amend, and a cherry-pick give a commit a new name while its
change stays the same. ADR-188's date test leaves such a copy out, because it
keeps the original's author date. So a copy can reach a pull request with no
run claiming it.

Each commit stores its patch id: `git patch-id --stable` over its diff
against its first parent. A commit no run claimed whose patch id matches a
claimed commit in the same workspace and repository is credited to the run
that made the original, with source `rewritten`. When several claimed
commits match, the one committed first is the original.

### 5. A work item reaches its runs through existing links

A work order is one send of a work item and has no run id. Each send's
`run_linked` facts in `work.item_facts` hold an `order_id` and a `run_id`,
and one send can hold several runs. A run with no send has a
`work.direct_orders` row, which can be attached to an item. A work item's
runs are a query over those two. There is no `work_item_runs` table, for the
reason ADR-294 gave for its queue: a copy of a link drifts as links are
added.

### 6. A commit on `main` reaches its runs through the pull request

After a squash merge or a rebase merge, the commits on `main` have names no
run made. The commit on `main` reaches its runs through
`forge.pull_requests.merge_commit_sha`, then the pull request's final
revision, then that revision's commits in `forge.revision_commits`, then
`forge.run_commits`. Nothing matches a name on `main` against a run's
commits.

### 7. Four measures

Each measure is defined once and means the same on every page.

- **Written:** the lines added and removed by the run's own commits, summed.
  A merge counts zero. A `rewritten` copy counts zero, because the run
  already wrote that change once. Written measures effort, churn included.
- **Shipped:** the lines in a merged pull request's final revision that trace
  back to the run's commits. A pure function over the revision's ordered
  commit diffs labels each added line with the run whose commit added it. A
  later commit that removes the line removes the label. The labels left on
  the net diff's added lines give each run's shipped additions. Shipped
  measures outcome.
- **Uncommitted:** the lines the run left in its worktree at its last
  reconciliation and never committed. This is the figure the Runs list shows
  today when git reports one. It never mixes with the other two.
- **Rework:** written minus shipped on merged pull requests, plus every
  written line on pull requests closed without merging. A commit on a pull
  request that is still open is not rework yet.

### 8. Sources are ranked on the ADR-095 ladder

ADR-095's tiers rest on the difference between what Oxagen saw and what it
was told, and `git-facts.ts` already reads file change on the observed side.
Each `forge.run_commits` row names its source, highest first:

| Source | Tier | Meaning |
|---|---|---|
| `observed` | observed | Tacho read the commit from git in the run's worktree under ADR-188's rule. |
| `attested` | attested | The run's own record names the commit, such as the output of a Bash `git commit` step. Only the backfill writes it. |
| `rewritten` | inferred | No run claimed this commit, and its patch id matches a commit an earlier run made (section 4). |

When two claims on one commit come from different sources, the higher source
holds. Two claims from the same source never replace each other. The first
holds, and the second is counted and logged with both run ids, so the
conflict is visible.

### 9. The `session_commits` frame field

The `oxagen:worktree_reconciled` frame's body gains three fields beside
`observed_changes`. The names below are fixed here, so the tacho change and
the server ingest can be built at the same time. The list belongs to the
repository the frame's existing `repository_url` attr names. No new attr is
added.

| Field | Type | When present |
|---|---|---|
| `session_commits` | list of commit items, at most 64 | Every frame sealed with `changes_basis: session`. An empty list means the rule ran and found no commits. Absent when `changes_basis` is `baseline`, because the rule did not run on that read. |
| `session_commits_total` | whole number | With the list. How many commits the session had before the cut. |
| `session_commits_truncated` | boolean | With the list. True when the list was cut. |

Each commit item:

| Field | Type | Bound | Meaning |
|---|---|---|---|
| `sha` | string | a full commit name, 40 or 64 hex digits | The commit. |
| `parent_shas` | list of strings | at most 16 | Its parents, first parent first. |
| `kind` | `change` or `merge` | | `merge` when it has more than one parent. |
| `patch_id` | string or null | 40 or 64 hex digits | `git patch-id --stable` over the diff against the first parent. Null for a merge, for a commit with no diff, and when the read failed. |
| `authored_at` | protocol timestamp | | The author date. |
| `committed_at` | protocol timestamp | | The committer date. |
| `subject` | string | at most 256 characters | The first line of the message. |
| `added` | whole number | | Lines added across every file of the commit, before the file cut. Zero for a merge. |
| `removed` | whole number | | Lines removed across every file of the commit, before the file cut. Zero for a merge. |
| `files_total` | whole number | | How many files the commit touched, before the cut. Zero for a merge. |
| `files` | list of file items | at most 16 | The files, sorted by path, then cut. Empty for a merge. |
| `test` | `unpushed`, `reflog`, or `email` | | The ADR-188 test that held (below). |
| `tool_use_id` | string | at most 512 characters | Optional. The Bash tool call that made the commit (below). |
| `files_outside_session` | boolean | | Optional. True when the commit touched a path the session never wrote or edited (below). |

Each file item has `path` (repo-relative, the new path for a rename),
`status` (`added`, `modified`, `deleted`, or `renamed`, the values
`observed_changes` uses), `added`, and `removed`. A binary file counts zero
lines.

The rules behind the fields:

- **The list is cumulative.** Each reconciliation lists every commit the
  session has made in that worktree so far, oldest first, as
  `observed_changes` lists every changed path. A cut keeps the newest 64.
  An earlier frame already carried the commits a cut drops, so the server
  loses none unless 64 commits land between two reconciliations. The ingest
  is idempotent on the commit and the run, and a frame that leaves out a
  commit never removes its claim.
- **The bounds keep a frame inside the request budget.** A frame ships in a
  batch whose request may not exceed 900,000 bytes, and its body travels
  twice, once as JSON text (`MAX_OBSERVED_CHANGES` in `envelope.ts` explains
  both). With paths of about 60 characters, 64 commits with 16 files each
  come to about 300 KB on the wire, the second copy included. With a full
  `observed_changes` list the frame stays under half the budget. The forge
  stores each commit's full file
  list later (phase 3), so `added`, `removed`, and `files_total` carry the
  totals the cut list does not.
- **Merges are read apart from the session's own commits.**
  `sessionCommits` reads `baseline..HEAD` with `--no-merges`, and its result
  feeds `filesOfCommits`, which decides the frame's reported paths. A merge in
  that list would put every path the merge brought in back into the
  reconciliation, which is the defect ADR-188 fixed. So the lane reads merges
  with `--merges` over the same range and the same date and ref tests, keeps
  them in a separate list in daemon state under the same bound, and never
  adds them to `ownCommits`.
- **`test` names the first test that held,** in the order `sessionCommits`
  checks them: `unpushed` (no remote-tracking ref reaches it), then `email`
  (its committer email is the one the repository stamps), then `reflog` (the
  worktree's `HEAD` reflog records it as made there). The reflog is read only
  for commits the other two left out. A commit carried from an earlier read
  keeps the test it passed when it was first counted.
- **`tool_use_id` is present only when one tool call matches.** The commit's
  `HEAD` reflog entry is dated inside exactly one `git_commit` effect the
  daemon recorded for the session, between the tool call's start and its end.
  It is absent when the reflog has no entry for the commit, or when no effect
  or more than one effect matches.
- **`files_outside_session` compares against the session's own writes.** It
  is true when at least one path the commit touched, counted over every file
  and not just the cut list, is not a path the session's tool calls wrote or
  edited. Those are the attested file facts behind the `tacho.session_files`
  counters. It is absent when the daemon holds no such record, as for a
  session restored from an older state file. A `true` value flags a commit
  that may hold another run's edits, as `git add -A` does in a shared
  checkout.

## Alternatives considered

- **A commit table keyed on the pull request.** A force-push changes which
  commits a pull request holds, so the rows would change under a stored
  revision that ADR-288 makes final. Keying on the repository keeps a dropped
  commit, and `forge.revision_commits` records which commits each head held.
- **Inferring the run from commit times.** Two runs on one branch, such as a
  builder and a watcher that merges main to clear conflicts, commit in the
  same minutes. Matching a commit time to a run's active window would credit
  the wrong one.
- **Trailers as the main source.** A squash merge writes the pull request
  body as the message, so a branch commit's trailer never reaches `main`.
  Agents also do not add trailers reliably: none of #5375's commits has one.

## Consequences

- **The Runs list** shows written lines that link to the Run page's Changes
  panel, shipped lines once a pull request merges, and uncommitted lines only
  when something was left. A run that committed everything stops showing
  nothing.
- **The Run page's Changes panel** shows each pull request the run committed
  to with the run's own commits, its merges as merges, and the other runs on
  that pull request. A file's diff opens on this run's commits, with a switch
  to the whole pull request. This amends ADR-292's rule that a run's change
  set is each linked pull request's net change.
- **The work item's Changes panel** lists each send's runs, a contributors
  table, and shipped lines and spend per shipped line across sends.
- **Spend** credits each run with its own shipped lines, not the whole pull
  request. `cost.run_pr_outcomes`, which credits every run on a merged pull
  request in full, is replaced for this figure.
- **Agents** show shipped lines and the share of written lines that shipped,
  and a Waste finding names runs whose commits never shipped.
- **The Repositories Changes tab** lists every pull request on the
  workspace's repositories with its contributing runs, shipped lines, and
  certification state.
- **Older runs have no commit list** until a backfill proves one from the
  run's own record, with source `attested`.
- **Known limit.** ADR-188's reflog test reads only the subjects git writes
  when it makes a commit, and a merge writes another one. So a merge the
  session made and pushed in the same turn is found only by the email test.
  It is credited zero lines either way, so only its listing is lost.

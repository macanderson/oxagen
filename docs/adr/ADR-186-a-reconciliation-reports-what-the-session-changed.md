# ADR-186: A reconciliation reports what the session changed

- **Status:** Accepted
- **Date:** 2026-09-25
- **Owners:** tacho, evidence
- **Related:** issue #4104, issue #3384 (finding 29), ADR-095 (observed and
  attested facts), `docs/specs/tacho/spec.md` §3,
  `docs/specs/tacho/data-model.md` §3.2.

## Context

The collector's git lane seals an `oxagen:worktree_reconciled` frame at the
end of each turn. The frame listed every path that differed from the commit
the session was on at its first git read (the baseline). The Run page, the
run title, and `session_files` read that list as the files the session
changed.

Three kinds of change land in that list without the session making them:

1. **Commits it pulled.** A session in a worktree that started on `d5c7084f`
   moved to `595cfe51` on `main`, six other pull requests later. The next
   frame reported 159 changed paths, and none of them was that session's work.
2. **Untracked files already there.** The untracked half came from
   `git status` at read time, so a file present before the session read as
   `added`.
3. **Uncommitted edits already there.** The tracked half was
   `git diff <baseline>`, so a person's edit left uncommitted before the
   session read as the session's.

The baseline had to stay fixed at the first read, because a session that
commits its own work moves `HEAD`. Measuring from `HEAD` records none of that
work.

## Decision

A path is in a reconciliation when the session changed it. The rule lives in
`readSessionChanges` (`packages/tacho/src/collector/session-changes.ts`).

1. **The session's own commits.** The lane stamps the session's first git
   read (`gitFirstReadAt`). A commit is the session's when it is a non-merge
   commit in `baseline..HEAD`, its committer email equals the email the
   repository stamps (its `user.email`, or the identity git derives when none
   is set), and its committer date is at or after that first read, floored to
   the second. A commit counted once stays counted for that worktree
   (`sessionCommits`).
2. **What is reported.** The files those commits touched, measured against the
   baseline, plus the worktree's changes against `HEAD`, tracked and
   untracked.
3. **Edits already there.** At the session's first read of each repository
   root, the lane records the dirty paths with a content hash
   (`preexistingPaths`). A recorded path stays out of later reports until its
   content changes. A path the session committed is reported whatever it held
   before.
4. **The frame says which measure it used.** `changes_basis` is `session` or
   `baseline`. `pre_session_changes` is `excluded`, `partly_excluded` (a bound
   cut the record short), or `included` (no record was taken for the
   worktree).
5. **The captured diff agrees.** The patch sealed beside a reconciliation
   covers the reported paths and no others.
6. **Older sessions keep the old measure.** A session restored from a state
   file written before `gitFirstReadAt` existed is measured against its
   baseline for the rest of its life, with `changes_basis: baseline`. Setting
   the clock on its next read would call every commit it made before the
   upgrade someone else's.

A pull, a fetch and reset to upstream, and a rebase onto upstream therefore
add no upstream file. Upstream commits carry another committer email, or a
date before the session. A rebase stamps the session's replayed commits with
its email and the time it ran, so they still count.

### Two refinements to the rule as first decided

The rule as first decided counted only the commits in `baseline..HEAD`, and
took the record of existing edits at the first read. The code showed a flaw in
each.

- **A squash merge brought back through a pull erased the session's work.**
  After the forge squash-merges the session's branch and the session pulls
  `main`, its own commits are no longer in `HEAD`'s history, and the squash
  commit carries the forge's email. The last frame then omitted the session's
  files, and an untruncated reconciliation clears the observed status of every
  path it omits (data-model §3.2), so the run's file rows lost them too. A
  commit counted once now stays counted, and its files are measured against
  the baseline.
- **The first read of a worktree can come after the session's first edit in
  it.** A hook moves the session to another worktree when a tool call writes a
  file there, and the lane reads on a later tick, after the write. A record
  taken then would list the session's own edit as already there. The lane now
  records only paths whose modification and change times are older than the
  session's start, and, for a deleted path, whose directory's are.

## Alternatives

- **Re-baseline when `HEAD` moves to a commit a remote-tracking ref already
  held.** Rejected. A session's own commits are reachable from its upstream
  once it pushes, so the test cannot tell its pushed work from a pull.
- **Read the `HEAD` reflog.** Its `commit:` entries name the commits made in
  this worktree, and `pull:` and `reset:` entries name the moves. Rejected for
  now: the reflog is free text, it can be switched off, and it cannot tell a
  person's commit in the same worktree from the session's either.
- **Snapshot the whole worktree at the first read.** Rejected. Its cost grows
  with the repository rather than with the dirty paths.

## Known limits

The rule cannot tell these apart, and the record overstates or understates in
each case as named.

- **Another writer with the same email after the first read.** A sibling
  session in another worktree whose commits reach this one through a merge
  commit, a person committing in the same repository, and a `cherry-pick`,
  which stamps the picker's email and the current time. These are reported as
  the session's. Squash and rebase merges on GitHub carry GitHub's committer
  email, so they are not.
- **An agent that commits under another email** than the repository's
  configuration, for example through `GIT_COMMITTER_EMAIL` in its own
  environment. Its commits read as someone else's and are not reported.
- **An upstream change to a path the session also committed** is counted with
  it, because that path is measured against the baseline.
- **A commit made before the first read of a worktree**, including the first
  commit of a repository that had none, is inside the baseline and is not
  reported. This limit predates this ADR.
- **A person's edit made while the session runs** is reported as the
  session's.
- **Bounds.** The record holds 256 paths per worktree and hashes files up to
  16 MiB, comparing larger ones by size and modification time. A session keeps
  128 commits and records for 16 worktrees. A dirty path past the bound is
  reported, and the frame says `partly_excluded`.

## Consequences

- A session that pulls, resets, or rebases onto upstream reports only its own
  files, so the Run page's file count and the run title stop counting other
  people's merges.
- The first read of each worktree costs one whole-tree `git status` and a hash
  of each recorded path. A reconciliation after `HEAD` moved adds a `git log`
  of the range and one of the counted commits.
- `daemon.json` holds the record and the counted commits with the session,
  within the bounds above.
- The captured diff after a pull no longer carries the upstream files.

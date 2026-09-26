# ADR-188: A reconciliation reports what the session changed

- **Status:** Accepted. Amended 2026-09-25: the commit rule and the captured
  diff (#4320), and the count for a file that already held edits (#3384).
  See the amendments at the end.
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
   commit in `baseline..HEAD`, both its committer date and its author date
   are at or after that first read, floored to the second, and one of three
   tests holds: no remote-tracking ref reaches it, the worktree's `HEAD`
   reflog records it as made there, or its committer email equals the email
   the repository stamps (its `user.email`, or the identity git derives when
   none is set). A commit counted once stays counted for that worktree
   (`sessionCommits`).

   > Amended 2026-09-25 (#4320). As first decided, the email was the only
   > test beside the dates, so an agent that committed under another email
   > had none of its commits counted. See the amendment at the end.
2. **What is reported.** The files those commits touched, measured against the
   baseline, plus the worktree's changes against `HEAD`, tracked and
   untracked.
3. **Edits already there.** At the session's first read of each repository
   root, the lane records the dirty paths with a content hash
   (`preexistingPaths`). A recorded path stays out of later reports until its
   content changes. A path the session committed is reported whatever it held
   before. Once a recorded path changes, its row counts the session's lines
   alone, measured from a copy of what it held at the first read.

   > Amended 2026-09-25 (#3384). As first decided, a recorded path that
   > changed was reported whole against `HEAD`, the person's lines with the
   > session's. See the amendment at the end.
4. **The frame says which measure it used.** `changes_basis` is `session` or
   `baseline`. `pre_session_changes` is `excluded`, `partly_excluded` (a bound
   cut the record short), or `included` (no record was taken for the
   worktree). `pre_session_edit_counts`, present when the list holds a path
   that already held edits, is `session_only` or `whole_file` (at least one
   such row counts the whole file, because no copy was kept).
5. **The captured diff describes the same change as the rows.** The patch
   sealed beside a reconciliation covers the reported paths and no others,
   and takes each path against the state its row's line counts came from. A
   path the session committed is taken against the baseline
   (`diff_base_sha`). Any other path is taken against the `HEAD` the
   reconciliation read, or against nothing when it is untracked. The
   snapshot names that `HEAD` and the committed paths in `bases`, and marks
   the patch partial (`head_changed_during_capture`) when `HEAD` moved
   before the capture. A patch with a hunk that differs from what the
   baseline would give is marked partial too (`mixed_bases`), so a reader
   does not apply it to `diff_base_sha`.

   > Amended 2026-09-25 (#4320). As first decided, the patch took every path
   > against the baseline, so its hunks could differ from a row's line
   > counts.
6. **Older sessions keep the old measure.** A session restored from a state
   file written before `gitFirstReadAt` existed is measured against its
   baseline for the rest of its life, with `changes_basis: baseline`. Setting
   the clock on its next read would call every commit it made before the
   upgrade someone else's.
7. **A read the rule cannot make falls back to the old measure.** When the
   status read answers but a later probe fails (the commit range, the files
   of the counted commits, or a diff), the frame is sealed on the baseline
   measure with `changes_basis: baseline`. A range longer than the exec's
   buffer or its timeout is the likely cause. A frame that overstates and says
   so replaces no frame at all.

A pull, a fetch and reset to upstream, and a rebase onto upstream therefore
add no upstream file. Upstream commits are on a remote-tracking ref once
fetched, and carry another committer email or dates before the session. A
rebase gives every commit it replays a new name and the time it ran, but it
keeps each one's author date. So the session's own rebased commits still
count, and a commit written before the session, which the session checks
out and rebases, does not. The same holds for an amend without `--reset-author`,
and for a `cherry-pick` of a commit written before the session.

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
  session's start, and, for a deleted path, whose directory's are. The start
  is the registry's `startedAt`. For a session whose `SessionStart` was
  spooled while the daemon was down, that is the time the hook received it,
  not the time the daemon replayed it.

### A refinement found in review

The committer date alone let a replay pass as the session's work. A rebase,
an amend, and a cherry-pick stamp a new committer date on a commit someone
wrote earlier. A session that checked out a branch holding yesterday's
unpushed commit and rebased it onto `main` had that commit counted as its
own, with the session's email and a committer date after its first read. The
rule now requires the author date too, which those three commands keep. The
trade-off is that a session that amends a commit written before it started
is not credited for the amendment.

## Alternatives

- **Re-baseline when `HEAD` moves to a commit a remote-tracking ref already
  held.** Rejected. A session's own commits are reachable from its upstream
  once it pushes, so the test cannot tell its pushed work from a pull.
- **Read the `HEAD` reflog as the only test.** Its `commit:` entries name the
  commits made in this worktree, and `pull:` and `reset:` entries name the
  moves. Rejected as the only test, because the reflog can be switched off.
  The 2026-09-25 amendment adds it as one of three tests, so a worktree with
  no reflog falls back to the other two. It cannot tell a person's commit in
  the same worktree from the session's, which the known limits name.
- **Snapshot the whole worktree at the first read.** Rejected. Its cost grows
  with the repository rather than with the dirty paths.

## Known limits

The rule cannot tell these apart, and the record overstates or understates in
each case as named.

- **Another writer after the first read.** A sibling session in another
  worktree whose commits reach this one through a merge, and a person
  committing in the same repository, both write commits dated after the
  session's first read. These are reported as the session's when they reach
  this worktree before any remote holds them, or carry the session's email.
  Squash and rebase merges on GitHub carry GitHub's committer email and
  arrive through a fetch, so they are not. A cherry-pick of an upstream
  commit authored after the first read is reported, because the session made
  the new commit.
- **An agent that commits under another email and pushes in the same turn,
  in a worktree with no `HEAD` reflog.** Amended 2026-09-25 (#4320). By the
  end-of-turn read, the commit is on a remote-tracking ref, its email is not
  the repository's, and no reflog names it, so it reads as pulled and is not
  reported. Git keeps the reflog by default (`core.logAllRefUpdates`).
- **A pull that updates no remote-tracking ref**, such as
  `git pull <url> <branch>`, brings in commits no remote-tracking ref holds.
  Those dated after the first read are reported as the session's.
- **An amendment to a commit written before the session.** The amended
  commit keeps the older author date and is not counted.
- **An upstream change to a path the session also committed** is counted with
  it, because that path is measured against the baseline. Its hunk in the
  captured patch holds the upstream change too, so the two agree.
- **A commit made before the first read of a worktree**, including the first
  commit of a repository that had none, is not reported. When it is inside
  the baseline, no diff shows it. When the session checks it out later, its
  dates are before the first read. This limit predates this ADR.
- **A session first seen without a hook.** A session the daemon first meets
  through OTel or the transcript reader has its start dated at that sighting.
  A later replayed hook moves the start back to its receipt time, but a
  session whose hooks were never spooled keeps the later date, and an edit it
  made before that date can be recorded as already there.
- **A person's edit made while the session runs** is reported as the
  session's.
- **Bounds.** The record holds 256 paths per worktree and hashes files up to
  16 MiB, comparing larger ones by size and modification time. A session
  keeps at most 8 MiB of copies across its worktrees, chosen in path order.
  A changed file with no copy (past that bound, past 16 MiB, or a symbolic
  link) counts the whole file against `HEAD`, and the frame says
  `pre_session_edit_counts: whole_file`. One read lists
  at most 1,024 of the session's commits from `baseline..HEAD`, filtered by
  committer email inside git. A session carries 128 commits from one read to
  the next and keeps records for 16 worktrees. A commit still in the range is
  found again on every read, so the carried bound only drops commits that
  left the range. A dirty path past the bound is reported, and the frame says
  `partly_excluded`.

## Consequences

- A session that pulls, resets, or rebases onto upstream reports only its own
  files, so the Run page's file count and the run title stop counting other
  people's merges.
- The first read of each worktree costs one whole-tree `git status` and a hash
  of each recorded path. A reconciliation after `HEAD` moved adds a
  `git config` read, a `git log` of the range filtered to the session's email,
  a `git log` of the range less every remote-tracking ref, a walk of up to
  1,024 `HEAD` reflog entries, and one `git log` of the counted commits. Each
  commit the reflog names that the other two tests left out costs one more
  `git log` for all of them and one `git merge-base` each, at most 128.
- `daemon.json` holds the record and the counted commits with the session,
  within the bounds above. `pre-session/<session uuid>/` under the Tacho
  state directory holds the copies. The daemon removes it when it forgets
  the session, and `tacho unenroll` removes the whole `pre-session/`
  directory, since no daemon is left to.
- The captured diff after a pull no longer carries the upstream files.

## Amendment 2026-09-25: a commit made in the worktree is the session's (#4320)

The rule as first decided counted a commit only when its committer email
was the repository's. An agent whose shell exports `GIT_COMMITTER_EMAIL`, or
that runs `git -c user.email=... commit`, stamps another email, and the
daemon reads the repository's configuration in its own environment. None of
that agent's commits were reported.

A commit now also counts when no remote-tracking ref reaches it. A pull
fetches before it merges, so every commit a pull brings in is on a
remote-tracking ref by the time `HEAD` holds it. A commit made in this
worktree is on none until it is pushed. The date test still applies, so a
commit written before the session stays out whatever reaches it.

A commit the agent made and pushed in the same turn is on a remote-tracking
ref by the end-of-turn read, which is the only read a turn gets. So a commit
also counts when the worktree's `HEAD` reflog records it as made there since
the first read. Git writes `commit:`, `commit (amend):`, `cherry-pick:`,
`revert:`, and `rebase (pick):` (or `pull --rebase (pick):`) when it makes a
commit, and `pull:`, `merge`, `reset:`, and `checkout:` when it moves `HEAD`
to a commit made elsewhere. Each commit the reflog names must still be an
ancestor of `HEAD`, so a commit an amend or a reset replaced is not counted.
This covers `git commit && git push` inside one tool call too.

The email test stays beside the other two. It counts a commit the session
pushed in the same turn in a worktree whose reflog is off.

- **Rejected: forward `GIT_COMMITTER_EMAIL` from the hook.** It would fix the
  same-turn push for an agent whose harness exports the variable, which is
  the case #4320 names. The hook sees the environment the harness started
  in, though, and not an identity set for one tool call
  (`GIT_COMMITTER_EMAIL=... git commit` or `git -c user.email=...`). It
  would also send an email address in every hook. The reflog covers all
  three without either, so the hook's environment allowlist is unchanged.
- **Rejected: read the session's own commits on each Bash `PostToolUse`.**
  A read after the tool call that made a commit, before a later call pushed
  it, would find it on no remote-tracking ref. It misses a commit and a push
  inside one tool call, and adds a git read to every Bash call.
- **Rejected: the tips of the remote-tracking refs at the first read.**
  Upstream commits pushed after the first read are not reachable from those
  tips, and a fast-forward pull brings them in with no merge commit to
  exclude. The test has to read the refs as they stand at each read.

## Amendment 2026-09-25: the captured diff takes each path against its row's base (#4320)

A row for an uncommitted edit counts its lines against `HEAD`. The patch
beside it took every path against the baseline. After a pull that changed a
file the session then edited, the row counted the session's edit and the
patch also held the pulled hunk.

`readSessionChanges` now returns what it measured each path against, and
`readWorktreeSnapshot` takes each path's hunk against the same state:
committed paths against the baseline, other tracked paths against the
`HEAD` the reconciliation read, and untracked paths against nothing. The
frame keeps one `diff_base_sha`, the baseline. The snapshot body gains
`bases`, which names the `HEAD` it used (`head_ref`) and the committed
paths (`baseline_paths`), so a reader can tell which base each hunk used
without the frame changing shape. `run-work.ts` reads only the frame's
attrs and the Run page shows the patch's metadata, so neither changes.

A patch with any hunk that differs from what `diff_base_sha` would give
lists `mixed_bases` in its limitations, and so reads as partial on the Run
page. That holds when a pull between the baseline and `HEAD` changed a path
taken against `HEAD`, and whenever the patch holds a file that already held
edits (the next amendment). The patch still covers every reported path. The
limitation tells a reader it does not apply to `diff_base_sha`.

## Amendment 2026-09-25: a file that already held edits counts the session's lines (#3384)

The rule as first decided left a person's uncommitted edit out of the list
until its content changed, then reported the file whole against `HEAD`. A
file with forty lines of a person's work and one line of the session's read
as forty-one lines of the session's.

At the session's first read of a worktree, the lane now copies each
recorded file into `pre-session/<session uuid>/` under the Tacho state
directory, named by the hash the record already holds. The copy is written
in the same pass that hashes the file, under a temporary name renamed once
whole. Nothing is written into the repository or its `.git`. Once a
recorded path changes, its row is measured from what it held then to what
it holds now:

- A file the session edited is `modified`, with the session's lines. That
  holds for a file a person created and never committed as well.
- A file the session deleted is `deleted`, with the lines it held at the
  first read.
- A file the session put back as `HEAD` has it is reported `modified`, with
  the lines the revert took out. As first decided, it dropped out of the
  list, because it no longer differs from `HEAD`.
- A path that was deleted at the first read and that the session wrote
  again is `added`, with everything it holds, and needs no copy.

The captured patch takes the same paths against the same copies, with the
header rewritten to the repo-relative path so the state directory never
reaches the record, and the snapshot lists them in
`bases.pre_session_paths`.

A session keeps at most 8 MiB of copies (`MAX_PRE_SESSION_COPY_BYTES`).
Past that, a symbolic link, or a file past 16 MiB gets no copy. Its row
falls back to the whole file against `HEAD`, and the frame says
`pre_session_edit_counts: whole_file`, so a reader can tell those counts
include lines the session did not write. A session restored from a state
file written before this change has no copies and takes the same fallback.

The copies are the person's own worktree content, which the worktree still
holds. They are never shipped, and a narrowing of the retention mandate
does not reach them. The daemon removes a session's directory when it
forgets the session, and removes any directory no session in its registry
owns on the same sweep, which covers a crash.

- **Rejected: a copy of every dirty file with no bound.** Its cost grows
  with the dirty files, and a build directory can hold gigabytes.
- **Rejected: storing the copies as git objects.** `git hash-object -w`
  writes into the repository's object store, which is the person's.

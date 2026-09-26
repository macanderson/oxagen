# ADR-197: A run stamps its own circumstances and reads the tracker on load

- **Status:** Accepted
- **Date:** 2026-09-26
- **Owners:** run, evidence
- **Related:** issue #3999 (operator role), issue #3970 (`get_run_issues`),
  issue #3890 (the Release row), ADR-171 (a chain break is reported beside a
  run's facts), `docs/capabilities/run.issues.get.md`,
  `docs/capabilities/run.work.get.md`.

## Context

The Run page shows three facts that the frames do not carry on their own.

1. **The operator's workspace role.** The Summary draws the operator as
   "operator · workspace.owner · core-platform". The role lives in
   `workspace.workspace_users.role`, and it changes: a person is promoted,
   demoted, or removed. A run read a month later that joined the membership
   table would print the role the person holds today, not the one they held
   when the run happened.
2. **An issue's title and status.** The Issues tab lists the issues a run
   worked on. The run's frames name an issue (a `gh issue comment 482` command,
   a GitHub MCP call on `issue_number: 482`), and a pull request the run opened
   names the issues it closes. None of them carries the issue's title, or
   whether it is open or closed now. Before this record the tab printed the
   task's status as "not recorded" and drew no row for an issue the run only
   read or commented on.
3. **A release's state.** The Changes panel printed "Release: not recorded"
   on every run, because no record stored a release. A `gh release create
   v4.11.0 --draft` command frame names the tag, and only GitHub knows
   whether that release is still a draft.

The first fact belongs to the run. The other two belong to a tracker that
keeps changing them after the run ends, and a person opening the page wants
the tracker's answer now.

## Decision

A fact about the run's own circumstances is stamped when the run opens and
never rewritten. A fact a tracker owns is read from the tracker when the page
loads, and the answer says when it was read or why it was not.

1. **The operator's role is stamped at open.** `tacho.sessions.operator_role`
   and `agent.agent_runs.operator_role` hold the operator's workspace role,
   lowercased, as the membership row reads at the moment the run is created.
   Ingest's genesis row writes it for a wrapped session
   (`enrollingOperator` in `tacho.events.ingest.ts`), and the existing-session
   path never writes it. `buildCreateRunSql` writes it for a ledger run with a
   scalar subselect, so every caller of `createRun` stamps it and none can pass
   its own. Only a human principal gets a role. `list_runs` and `get_run`
   return the stamped value and never join `workspace_users`, so a role
   changed after the run opened does not change what the run says. A run
   recorded before the column reads null, and the Summary prints "role not
   recorded" for a person's run with no stamp.
2. **An issue link comes from a record, never from a guess.** `get_run_issues`
   lists three kinds of issue. The task is the run's own reference (`stated`).
   An issue a pull request the run recorded opening closes comes from GitHub's
   `closingIssuesReferences` for that pull request (`observed`, `resolves`). An
   issue a frame names comes from the run's command frames and GitHub MCP
   frames (`observed`, `referenced`). The server parses a command frame's
   `tool_target` for `gh issue <verb> <N|URL>`, `gh api repos/o/r/issues/N`,
   and literal `github.com/o/r/issues/N` URLs, and it reads the recorder's
   `issue.*` attrs where a frame carries them. A branch name, a pull request
   matched only by branch, and model output add nothing.
3. **A bare `#N` resolves only from the record.** The order is the command's
   own `-R` or `--repo`, then the one repository recorded for the checkout at
   the frame's path, then the run's only recorded repository. Otherwise the row
   keeps `ref: "#N"`, `repository: null`, and `statusRead:
   "repository_unknown"`.
4. **The tracker is read on load, through the workspace's connection.** The
   handler groups the issues by connected repository, reads each group through
   that repository's connection (`resolveGitHubToken` with its
   `connectionId`), and caps a run at 50 issue reads. An in-process cache holds
   each answer for 60 seconds, keyed by organization, workspace, repository,
   and number, so one workspace never reads another's cached answer. The entry
   keeps the time GitHub answered, and `readAt` is that time, not the time the
   cache was hit. `statusRead` names why a state is missing: `no_connection`,
   `not_github`, `repository_unknown`, `not_found`, `read_failed`, or
   `read_limit`. A missing state stays null, and the tab says so rather than
   guessing one.
5. **A release is read on load by its tag.** `get_run_work` reads the run's
   `gh release create <tag>` command frames, resolves the repository by rule
   3, and reads the repository's releases from GitHub to find the tag. The
   state is `draft`, `prerelease`, or `published`, and null with
   `release_not_found` or `release_read_failed` when GitHub has no answer. A
   release whose repository the record cannot resolve is left out with
   `release_repository_unknown`, because a row with no repository would name a
   release nobody can find.
6. **The server read does not wait for the recorder.** The recorder writes
   `issue.repository`, `issue.number`, `issue.url`, and `issue.action` on the
   effect frame of a GitHub MCP issue tool and of `gh issue create`
   (`issueAttrs` in `packages/tacho/src/claude-code/tools.ts`). Those reach a
   host with the next desktop release. The server parses command heads, so a
   frame recorded before that release still yields its issues.

## Consequences

- A run keeps the role its operator held, whatever happens to the membership
  afterwards. A run from before the column cannot be given one, because a
  backfill would stamp today's role and call it history.
- Opening a run page reads GitHub once per connected repository the run named,
  at most 50 issues, and the cache absorbs a reload inside 60 seconds. A
  workspace with no connection for a repository still sees the row, with
  `statusRead: "no_connection"`.
- `get_run_issues` counts the issues a run touched, not a floor guessed from a
  branch. The tab's count is a floor only when a read limit cut the list.
- A `gh issue create` recorded before the recorder change names no number in
  its command, so its issue is missing until the host runs the release that
  writes `issue.*` attrs.
- `in_progress` and `blocked` are in the status vocabulary for trackers that
  report them. GitHub reports only open and closed, so a GitHub issue reads as
  one of those two.

## Alternatives considered

- **Join `workspace_users` on every read.** Rejected: it answers today's role
  and calls it the run's.
- **Stamp the issue's status when the run opens or seals.** Rejected: the
  person reading the page asks whether the work is done now, and a stamped
  status goes stale the moment someone closes the issue.
- **Infer issues from branch names or commit messages.** Rejected: a branch
  named `fix/482` is a hint, not a record, and ADR-171's rule is that the page
  shows what the store holds.
- **Store a release when the run creates it.** Rejected for the same reason as
  the issue status: a draft is published later, by a person, and the page
  should say so.

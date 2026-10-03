# ADR-212: A workspace links a code repository by a steering PR

- **Status:** Accepted. Superseded in part by ADR-293 on 2026-10-03:
  migration 20261003170000 drops the trigger in decision 1, and decision 4's
  checks no longer include another workspace's steering claim. A `steering`
  head stays exclusive across workspaces, and a `linked` head may name a
  repository another workspace steers by.
- **Date:** 2026-09-27
- **Amended:** 2026-09-28, the provisional refusal removed and
  `bind_main_repository` kept until #4616. Amended again on 2026-09-28:
  PR #4647 (issue #4616) removed `bind_main_repository` and the provisional
  window.
- **Owners:** platform, steering
- **Related:** issue #4516 (lane S8), PR #4517 (the steering role), ADR-099
  (a workspace is born with its main repository, superseded in part here),
  ADR-065 (the provisional workspace), ADR-073 (an API key names a
  workspace), ADR-020 (per-workspace GitHub write credentials), ADR-209 (the
  steering repo writes the tool registry).

## Context

ADR-099 gave each workspace a main repository: a code repository whose
`.oxagen/` tree steered the workspace. A repository could be main for one
workspace only. `link_repository` wrote a `linked` head straight into
`ingestion.repository_binding_heads`.

The steering repo spec replaced the main repository with a steering
repository that Oxagen creates and holds. Lane S1 added the head role
`steering` beside `main` (migration 20260926120000), so every reader had to
accept both names for one thing.

A direct link left no trace in the steering record. The steering repository
could not say which code repositories its workspace links, nobody reviewed a
link, and the heads could drift from anything a person could read.

Some paths also read the scope of a wrapped session from the repository it
ran in. Once one code repository can be linked to many workspaces, the
checkout cannot name a workspace.

## Decision

1. **One steering role.** Migration 20260927185600 moves every `main` head.
   In each workspace, a `steering` head that already exists, or else the
   oldest `main` head, becomes `steering`. Every other `main` head becomes
   `linked`. The role check admits `steering` and `linked` only. A `steering`
   head stays exclusive across workspaces. `linked` heads have no limit, so
   one code repository can be linked to many workspaces. The unique index
   and the trigger keep their names, because the handlers map them to
   `main_repo_claimed`.
2. **Contract names stay.** The public contracts keep `role: "main" |
   "linked"` and the `main_repo_*` reason codes. `get_main_repository`
   answers the steering repository. New code and copy say "steering record"
   and "steering PR".
3. **workspace.toml lists the linked repositories.** The `[[repositories]]`
   list in `workspace.toml`, on the steering repository's production branch,
   is the record of which code repositories a workspace links. An entry names
   a repository as `github.com/<owner>/<name>`.
4. **`link_repository` opens a steering PR.** It runs the checks the head
   write runs (`repository.link.write.ts`): the installation, whether the
   installation can see the repository, another workspace's steering claim,
   and this workspace's heads. Then it opens a steering PR from
   `workspace/link-<owner>-<name>-<hash>` that adds the entry, and answers
   `status: "proposed"`. When the file already lists the repository, it
   answers `status: "listed"` and opens nothing. A second call reuses the
   branch and the open PR. The handler writes no head.
5. **`unlink_repository` follows the file.** When `workspace.toml` lists the
   repository, the handler opens a steering PR from
   `workspace/unlink-<owner>-<name>-<hash>` that removes the entry, and the head
   stays until that PR merges. A head the file does not list predates the
   steering record, so the handler deletes it at once and answers
   `status: "unlinked"`. The steering head cannot be unlinked.
6. **The head follows the merge.** Step 5 of the steering sync reads
   `workspace.toml` whenever the synced head moves. It calls the reconcile
   (`repository.link.reconcile.ts`) with the list the prior synced head held
   and the list the new head holds. The reconcile deletes a `linked` head
   only when the prior list named it and the new list does not. When nobody
   can tell what the prior list held, it deletes nothing. A synced commit
   with no `workspace.toml`, or with a file that is not workspace/v1, moves
   no head. A deleted file or a slip on its first line unlinks nothing. The
   reconcile writes a head, naming no Oxagen user, for each listed
   repository that has none. A repository it cannot link becomes one warning
   finding with code `repository_link`, and the sync still succeeds. The
   reconcile runs once per synced head, in step 5, and never in step 8. A
   second run at the same head changes nothing.
7. **A session's workspace comes from its enrollment.** The key the host
   enrolled with names the workspace (ADR-073). The repository a session runs
   in never picks its workspace or its scope.
8. **A run in an unlinked repository runs.** When a session's
   `git_remote_digest` matches no head in its key's workspace, Oxagen refuses
   nothing and charges the cost to that workspace. Migration 20260928001500
   adds `tacho.sessions.repository_unlinked`, which ingest writes once, on
   the session's genesis row. `get_run` and `get_tacho_session` answer it.
9. **The steering repository's credential stays with Oxagen.** Oxagen reads
   and writes a provisioned steering repository server-side through an
   installation token of the Oxagen GitHub App
   (`mintSteeringInstallationToken`). No agent receives that token.
   `create_github_token` refuses the steering repository with
   `steering_repo_propose_only`, and the agent changes the steering
   repository through a steering PR. Amended by ADR-228 on 2026-09-29: one
   app now serves code repositories and steering repos, so every token it
   mints carries the merge ruleset's bypass, and `create_github_token` no
   longer hands out the workspace installation's token for the steering
   repository.

## Consequences

- A link takes effect when its steering PR merges and the next sync runs,
  not when the call returns. The Repositories page, the setup wizard, the
  run page, and `oxagen repo link` show the steering PR and say "Merge the
  steering PR to finish linking." The wizard sets the production branch and
  opens the init PR only once the head exists.
- A person who edits `workspace.toml` by hand links or unlinks too, because
  the sync reads the merged file. The steering repository is the record.
- A head written before this record stays until someone unlinks it, because
  no prior list named it and the reconcile leaves it alone.
- A `workspace.toml` that does not read moves no head, and the sync warns.
- Only GitHub repositories link. An entry on another host is a warning.
- `bind_main_repository` is gone. Mac approved removing the app's bind
  controls on 2026-09-28, and PR #4647 (issue #4616) removed the capability,
  its route, its handler, the Repositories page's bind and GitLab project
  controls, and the init wizard's bind step. The steering repo job's bind step is now the only
  writer of a `steering` head, and a steering PR is the only way to write a
  `linked` head. The onboarding gate's provisional window (ADR-065) went with
  it: the `provisional` field of `get_onboarding_state` and `PROVISIONAL_DAYS`.
  No code reads the `provisional_until` and `main_repo_bound_at` columns.
  They stay for one release because `migration-gate` applies before
  `deploy-node`, and #4667 drops them. The Shared
  contract section of the steering-repo spec is unchanged: the `main` role
  enum and the `main_repo_*` reason codes stay.
- The provisional window refuses nothing. `publish_context_record` used to
  refuse the gate's workspace with `conflict: provisional` until
  `bind_main_repository` set `main_repo_bound_at`. Onboarding no longer binds
  a repository, so a new organization's first workspace could never publish a
  record. The refusal is gone.
- `repository_unlinked` has no backfill. A session recorded before the
  column reads `false`.
- Enrollment still reads the host's git remote and records it on the gate
  row as `detected_repository`. Since PR #4647 nothing reads that column: the
  onboarding screen offered it only as a repository to bind, and
  `get_onboarding_state` no longer returns it. The CLI's
  `.oxagen/workspace.json` is a gitignored choice one person makes for one
  checkout. It scopes that person's CLI calls and never a wrapped session.

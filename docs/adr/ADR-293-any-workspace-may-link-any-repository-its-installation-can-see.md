# ADR-293: Any workspace may link any repository its installation can see

- **Status:** Accepted
- **Date:** 2026-10-03
- **Owners:** platform, steering
- **Supersedes in part:** ADR-099 §3 (the trigger's refusals that involve a
  linked head, and the plane refusal on a link) and §4 (the refusal to link
  another workspace's steering repository). ADR-212 decision 1 (the trigger)
  and decision 4 (another workspace's steering claim among the link checks).
- **Related:** issue #5355, ADR-042 (data planes), ADR-212 decisions 7 and 9
  (a session's workspace comes from its enrollment, and no agent receives a
  steering repository's token), ADR-228 (one GitHub App and its ruleset
  bypass), `packages/handlers/src/repository.link.write.ts`,
  `packages/handlers/src/lib/repository-heads-anywhere.ts`,
  `packages/handlers/src/tacho.github_token.issue.ts`,
  `packages/database/atlas/migrations/20261003170000_repository_binding_heads_links_unrestricted.sql`.

## Context

A workspace binds repositories in two roles (ADR-212). Its `steering`
repository holds its steering records, and it has one. Its `linked`
repositories hold the code its agents work on, and it may have many.

ADR-099 made the old main role exclusive in both directions, and ADR-212 kept
that rule for `steering`. Three refusals followed from it:

- `link_repository` and the steering sync read other tenants' heads through
  `withSystemDb`. They refused another workspace's steering repository with
  `conflict: main_repo_claimed`.
- The store trigger `repository_binding_heads_exclusive_main` refused the
  same linked head. It also refused a steering head for a repository another
  workspace links, under the constraint name
  `repository_binding_heads_main_is_linked_elsewhere`, which the app read as
  `repository_linked_elsewhere`.
- On a dedicated Postgres plane, the cross-workspace read cannot see every
  head. There a link was refused with `main_repo_plane_unsupported`.

ADR-099 §4 gave two reasons for the first refusal. The first was that Oxagen
opened Context PRs on a linked repository. That ended on 2026-10-01: a linked
repository receives no steering PR. The second was that a link would give
this workspace a door into another workspace's steering records. A link
writes no record. It gives the workspace a binding head, and its agents reach
the repository only through the workspace's own GitHub App installation.
GitHub already decides whether that installation can see the repository.

The refusals blocked real use. A team whose workspaces share one repository
could not link the repository that steers one of them, even when every
workspace's installation could read it.

## Decision

Mac decided on 2026-10-03:

1. **A workspace is never refused a link because of another workspace.** It
   may link any repository its GitHub App installation can see. Many
   workspaces may link one repository, and one of them may also hold it as
   its steering repository. `link_repository` and the steering sync read only
   this workspace's heads. The refusals that remain are `main_repo_unbound`
   (no steering repository to hold `workspace.toml`), `main_repo` (its own
   steering repository), and `repository_already_linked`.
2. **Exclusivity belongs to the agent.** An agent is steered by exactly one
   steering repository. The workspace decides which one, and every run
   declares its workspace (ADR-212 decision 7). The store keeps two indexes:
   `repository_binding_heads_workspace_steering_uq` (a workspace has one
   steering repository) and `repository_binding_heads_main_repository_uq` (a
   repository steers one workspace, across every organization). The second is
   kept on purpose. Two workspaces steered by one repository would read their
   records from the same files.
3. **The trigger is dropped.** Migration 20261003170000 drops
   `repository_binding_heads_exclusive_main` and its function. The partial
   unique index refuses a second steering head for a repository on its own.
   A racing insert waits for the first one to commit, then fails under the
   index's name. `repository_binding_heads_repository_idx` stays, because
   `headsAnywhere` reads by the same two columns.
4. **A linked head gives no token for a steering repository.** Every token
   the shared GitHub App mints carries the merge ruleset's bypass (ADR-228).
   `create_github_token` already refused this workspace's own steering
   repository. It now also asks every workspace, on every plane, whether one
   steers by the repository (`steeringAnywhere`), and refuses with
   `steering_repo_propose_only` before it reads an installation. A workspace
   that links another workspace's steering repository can read it through
   its installation. It cannot write to it through Oxagen.
5. **The refusal codes go.** No handler answers `main_repo_claimed`,
   `repository_linked_elsewhere`, or `main_repo_plane_unsupported`. The app's
   sentences for the first two are removed. `assertGlobalClaimIsKnowable`
   and `assertPlaneStillShared` are deleted, because they guarded only the
   cross-workspace check on a link.

## Consequences

- A steering head may now sit beside another workspace's linked head for the
  same repository. Migration 20260918200000 deleted such pairs. Now they are
  valid.
- The code repository check (`linkedScopes` in
  `packages/handlers/src/code-repo-check/request.ts`) asks no workspace to
  check a pull request on a repository any workspace steers by, so a
  steering PR is never checked twice. So a repository that steers workspace A
  and is linked in workspace B gets no Oxagen code check in B. This case
  could not happen before. It is not a link refusal, so the rule stays.
- A link on a dedicated Postgres plane succeeds like any other. The steering
  index still holds within one Postgres only (ADR-042), as it did before. No
  organization is dedicated today.
- The steering provisioner binds a repository Oxagen created for the
  workspace and maps no refusal. A second workspace steered by one
  repository still fails at the index, and the job records the failed step
  as it did before. `repositoryHeadConflict` keeps the index's mapping to
  `main_elsewhere` for that case.

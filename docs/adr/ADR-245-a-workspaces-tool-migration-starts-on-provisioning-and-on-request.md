# ADR-245: A workspace's tool migration starts on provisioning and on request

- **Status:** Accepted
- **Date:** 2026-10-01
- **Owners:** tools, steering
- **Related:** issue #4948, issue #4478 (lane M13), ADR-209 (a migrated
  workspace's tool registry is written from its steering repo), ADR-211
  (review refuses the HTTP+SSE transport), ADR-219 (workspace steering
  import).

## Context

ADR-209 §5 gave `migrate()` in `packages/handlers/src/mcp-studio/migrate.ts`
the job of moving a workspace's connected MCP servers into its steering repo.
It builds one `tools/servers/<name>/` folder per server, opens the folders as
steering PRs of at most 299 files each, and names each moved row's folder in
`mcp.mcp_servers.steering_name`. Nothing called it. No capability, route, CLI
command, or background job reached it, so no workspace could migrate, and
`register_mcp_server`, `set_plugin_enabled`, and `import_tools` kept writing
rows with no review (#4478 step 5).

`migrate()` opens new PRs on every call. Its branch names carry a timestamp,
and the host has no lookup by branch prefix, so a second call cannot find the
first call's PRs. The rows it marks stay legacy until the publish after their
PR merges, so the rows alone do not say whether a PR is open, merged and
waiting on the publish, or closed unmerged.

## Decision

1. **A capability starts and retries the migration.**
   `migrate_tools_to_steering` (`packages/oxagen/src/contracts/tool.steering.migrate.ts`)
   is on the API, MCP, and CLI surfaces (`oxagen tools migrate`). Its handler
   checks for an org Owner or Admin itself (INV-29). It takes no input, since
   the workspace comes from the scope, and answers a state and the migration
   PRs. Its run is `runToolMigration` in
   `packages/handlers/src/mcp-studio/migration-run.ts`, with its database and
   host calls in `migration-deps.ts`.
2. **Provisioning starts it.** When a workspace's last provisioning step,
   `bind_repository`, records the steering repo `ready`, `runSteeringRepoStep`
   calls the same run as a service principal with no actor, in the
   workspace's tenant scope. A start that fails is logged at warn and never
   fails the step. The repo stays ready, and the capability retries the move.
   A rerun of the last step starts the run again, which the next decision
   makes safe. The organization repo holds no workspace's servers, so its
   provisioning starts nothing.
3. **The run records each PR, and a repeat answers it.** The run keeps a
   `tool_migration` record in the workspace's settings, beside
   `steering_repo` and `steering_import`. A wrapped opener saves each PR to
   the record the moment it opens, before `migrate()` marks its rows and
   before the next batch opens, so a batch that fails later leaves the earlier
   PRs findable. In order, the run:
   - refuses a workspace with no steering repo (not_found
     `steering_repo_not_ready`), naming `get_steering_repo`,
     `retry_steering_repo_provision`, and `import_workspace_steering` as the
     next step;
   - answers `already_migrated` when no legacy row is left to move;
   - asks the host for each recorded PR's state, and answers `already_open`
     with each open one;
   - claims the record with a ten-minute hold in one conditional update, the
     way `import_workspace_steering` does, and refuses a second caller with
     conflict `tool_migration_running`;
   - calls `migrate()` with the folders on the default branch, so a row whose
     PR closed unmerged is planned again under the same name, and answers
     `opened`.
   When `migrate()` opens nothing, a row whose folder is already on the
   default branch waits on the publish after its PR merged, and the run
   answers `already_migrated` with that PR. A row that could not be written
   as a folder makes the run refuse with conflict `servers_not_movable`,
   naming each such server and why.
4. **"Migrated" is what `steeringWriter()` reads.** The workspace has a
   steering repo, and no live, enabled, legacy row on the streamable-http
   transport is left, with a plugin row's install enabled and live.
   `listMovableLegacyServers` in `packages/agent/src/runtime/steering-pr.ts`
   reads those rows with the WHERE clause `countMovableLegacyServers` uses, so
   the capability and the direct paths cannot disagree. A `stdio` or `sse` row
   stays legacy and does not hold the workspace back (ADR-211).
5. **The registry writes are attributed to the capability.**
   `MIGRATE_CAPABILITY` in `migrate.ts` is `migrate_tools_to_steering`, the
   name the tenant scope records for each row `migrate()` reads or marks.

## Consequences

- A new workspace provisions a steering repo with nothing to move, and the
  start answers `already_migrated` without claiming or opening anything. A
  workspace whose
  steering repo arrives later, through the headless backfill or
  `import_workspace_steering`, gets its migration PR from the same start.
- A repeat call costs one host read per recorded PR and opens nothing while a
  PR is open. A PR closed unmerged is opened again on the next call, under
  the folder names its rows already hold.
- If the database refuses the save that records a PR, the run logs the PR
  number at error and goes on. A retry cannot see that PR and may open a
  second one with the same folders. A person closes the extra PR.
- The record holds PR numbers, URLs, and branches only. It holds no
  credential and no URL of a server.
- No UI calls the capability yet. Oxagen's own start on provisioning covers
  every workspace that provisions from now on, and the capability covers the
  rest.
- ADR-209's last consequence said `migrate()` throws
  `steering_pr_unavailable` until boot registers an opener. `register.ts`
  registers both the opener and the writer, so the capability answers
  conflict `steering_pr_unavailable` only in a process that skipped that
  module.

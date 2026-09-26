# ADR-192: Pull request state is stored per run and kept current by forge webhooks

- **Status:** Accepted
- **Date:** 2026-09-25
- **Owners:** tacho, fleet
- **Related:** issue #4129, issue #4128, PR #4120, ADR-042 (data planes),
  ADR-184 (the repository sync reads GitHub and GitLab deliveries),
  `packages/database/src/schema/tacho.ts` (`tacho.run_pull_requests`).

## Context

Fleet lists the pull requests each run's frames name (#4120). A frame records
a pull request's URL, number and repository. It never records the pull
request's state, because the state changes on the forge after the frame is
sealed. Every link on Fleet read "status unknown".

`get_run_work` reads the live state from GitHub for one run. A list page
cannot: a page of a hundred runs would make up to a thousand forge calls, and
a GitLab merge request or a self-hosted forge has no reader at all.

Three facts shape where the state can come from:

1. **A delivery cannot name a run.** A GitHub `pull_request` delivery names a
   repository and a number. A GitLab merge request hook names a project and an
   iid. Neither knows which runs linked the pull request.
2. **Deliveries arrive out of order,** and the `opened` delivery usually
   lands before the harness writes the frame that names the link.
3. **A URL proves nothing about access.** An organization can record a link to
   a pull request in someone else's private repository. Writing that pull
   request's state into the organization's rows would leak it.

## Decision

1. **The store.** `tacho.run_pull_requests` holds one row per root session and
   recorded URL: the provider, the lower-cased repository, the number, the
   state (`open`, `merged` or `closed`, or null until a forge reports one), a
   draft flag, when Oxagen last read the state (`state_seen_at`), and the
   forge's own `updated_at` for the held state (`source_updated_at`). It lives
   in the `tacho` Postgres schema beside `tacho.session_files`, under the
   standard tenant policy. The link stays in the frames. The row holds only
   what the frames cannot.
2. **Three writers keep it current.**
   - The GitHub App's `pull_request` deliveries
     (`packages/handlers/src/github.pull-request.webhook.ts`), called once
     from `apps/api/src/routes/v1/github-webhook.ts`. The route verified the
     HMAC, so the payload is GitHub's word and no read goes back to GitHub.
   - A GitLab project hook's merge request deliveries
     (`packages/handlers/src/gitlab.webhook.ts`), in the connection's
     workspace, under the payload's project path and, when the project moved,
     the path the connection was made under.
   - One live read when a link lands. The ingest sends
     `run/pull-request.linked` once per root session and URL, and
     `run.pull-request-backfill` stores the row and reads the state with the
     workspace's own GitHub or GitLab connection.
3. **Newer wins.** Every write carries the forge's `updated_at`. A write never
   replaces a row that holds a newer one, and a write with no `updated_at`
   replaces only a row that has none either.
4. **Only connected workspaces are written.** A GitHub delivery writes only
   the workspaces that hold a connected GitHub source for the delivering
   installation, each in its own tenant scope and on its organization's data
   plane (ADR-042). A GitLab delivery writes only the connection's workspace.
   The backfill reads with the workspace's own credentials, and a forge that
   answers 403, 404 or 410 leaves the state null. The writes are per workspace
   because the standard tenant policy judges an UPDATE by the scope's own
   workspace: `withOrgDb` widens reads only, and an org-wide UPDATE through
   it changes no row.
5. **`list_runs` reads the stored state.** It joins the links the frames name
   with the rows for the page's sessions in one Postgres read, beside the
   ClickHouse read. Each link gains `state` and `stateSeenAt`. A link with no
   row reads null for both, and a failed state read keeps every link with a
   null state and logs a warning.

## Consequences

- A repository no connection reaches never gets a state, and neither does a
  workspace of a connected organization that holds no connection itself. Its
  links read "status unknown", and so does every link to a forge other than
  github.com and gitlab.com, self-hosted GitLab included. That is the honest
  answer: Oxagen has no reader for them.
- Only the backfill creates a row. A webhook updates rows and never adds one,
  because a delivery cannot name a run. So a link recorded before the table
  existed, or one whose `run/pull-request.linked` event was lost, keeps "status
  unknown" until the run records the link again or a one-off backfill over the
  ClickHouse frames runs.
- The state is as current as the last delivery. A delivery GitHub never sends
  (the App is not subscribed to `pull_request`, or GitHub drops it) leaves the
  last stored state in place, and `stateSeenAt` says how old it is.
- The `pullRequests` filter on `list_runs` still reads the frames. Once every
  link has a row, the filter can become one Postgres `EXISTS` that a page
  total can count (#3837).
- The migration is written with the schema change and applied by
  `migration-gate` on merge (SCR-006).

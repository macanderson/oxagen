# ADR-292: Every pull request read comes from the forge store

- **Status:** Accepted
- **Date:** 2026-10-03
- **Owners:** runs, work, repositories
- **Related:** issue #5284, ADR-288 (the forge store), ADR-192 (state per run),
  ADR-251 (work order results), ADR-226 (pages follow the design of record),
  `packages/oxagen/src/contracts/forge.changes.get.ts`,
  `packages/oxagen/src/contracts/forge.revision.diff.get.ts`,
  `packages/handlers/src/lib/forge-pull-requests/read.ts`.

## Context

ADR-288 gave Oxagen its own record of every pull request and each head's
diff. The app did not read it. A scan on 2026-10-03 found pull request facts
read from seven places: ClickHouse frames, `tacho.run_pull_requests`, live
GitHub through `get_run_work`, `tacho.session_files`, `work.item_facts`,
`cost.run_pr_outcomes`, and live GitHub GraphQL for closing issues. The same
pull request could read differently on two pages. A work order could show
only one pull request, and no page showed what a run, a work order, a work
item, or an issue changed as a whole.

## Decision

1. **Pull request facts and diffs are read from the forge store.** Two read
   capabilities serve every page and every agent:
   - `get_change_set` lists the pull requests of a run, a work order, a work
     item, or an issue, each with its latest revision and files, and rolls
     their change up by repository.
   - `get_revision_diff` reads one revision's stored bytes, checks their
     sha256 against the recorded one, and splits them into files.
2. **Every link resolves in Postgres.**
   - Run to pull request: `forge.pull_request_runs`.
   - Work order to pull request: `forge.pull_request_work_orders`.
   - Issue to pull request: `forge.pull_request_issues`, new here, which the
     sync fills from the forge's closing references at each new head.
   - Work item to issue: the issue's node id, which `work.items.provider_id`
     already carries as `issue:node:<id>`, or the item's source URL.
   - Until a backfill moves older links into the forge store, the read also
     follows `tacho.run_pull_requests` and `work.item_facts` `pr_linked`
     facts, matched to forge rows by provider, repository, and number. Each
     query reads one schema, and the joins happen in code.
3. **Net change.** A pull request's net change is its stored revision: the
   diff from the merge base to its latest head. Across pull requests the
   change rolls up by repository, as the union of files with summed line
   counts. A path two pull requests changed is one entry that names both, and
   each one's hunks show under it. A pull request closed without merging is
   listed and left out of the roll-up. Hunks from different pull requests
   are never composed into one, because each starts from its own merge base,
   and a composed diff would describe no commit anyone can check out.
4. **Where each level shows.** No new page is added (ADR-226).
   - Run: the Run page's Changes panel.
   - Work item: a Changes panel on the work item page.
   - Work order: a section per send in that panel, because a work order has
     no page.
   - Issue: the run's Issues tab, for each issue, because an issue has no
     page.

## Consequences

- **One pull request reads the same everywhere,** and each level's diff is
  the stored bytes a check can cite by revision id and digest.
- **Two older stores are still read as fallbacks** until the backfill lands.
  Once every link is in the forge store, the fallbacks can be removed.
- **Checks are not in the forge store.** Pages that show a pull request's
  checks keep reading them from `work.item_facts` and GitHub until the store
  records them.
- **GitLab closing references are not read yet.** A GitLab issue reaches a
  pull request only through a work item's work orders.
- **Left as they are:** Spend's cost per merged pull request
  (`cost.run_pr_outcomes`) and Fleet's line count cell (worktree totals).
  Neither shows a pull request's diff.

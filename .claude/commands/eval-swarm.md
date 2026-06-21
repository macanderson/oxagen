---
description: Fan every eval-* evaluator agent across slices of the monorepo as a parallel swarm via the eval-swarm workflow — review, adversarially verify P0/P1, then route confirmed defects to break-fix for grouped remediation. Optionally scope to a path with an argument.
---

# /eval-swarm

Run the full `eval-*` evaluator fleet across the monorepo as a workflow-orchestrated swarm. Each slice of the tree is reviewed in parallel by every applicable lens (`eval-database`, `eval-typescript`, `eval-types`, `eval-comments`, `eval-architecture`, `eval-security`, `eval-performance`, `eval-silent-failure`), repo-wide auditors run once (`eval-compliance`, `eval-parity`, `eval-pr-hygiene`, `eval-test-build`, `eval-grep`), every P0/P1 candidate is adversarially verified against source, and confirmed code defects are routed to `break-fix` for grouped, worktree-isolated remediation.

`$ARGUMENTS` (optional) — a path prefix to scope the swarm (e.g. `packages/billing`, `apps/app`). Omit to sweep the whole repo.

## How to run it

The workflow sandbox has no filesystem access, so **you scout the slices first, then hand them to the workflow** (the recommended hybrid pattern).

1. **Discover slices.** List the work units under the requested scope:
   ```bash
   # default scope: every package and every app
   ls -d packages/*/ apps/*/ 2>/dev/null
   # or, if $ARGUMENTS is set, scope to it:
   ls -d $ARGUMENTS/*/ 2>/dev/null || echo "$ARGUMENTS"
   ```
   Build one slice object per unit:
   - `id`: short name (the directory basename).
   - `path`: repo-relative path (e.g. `packages/billing`).
   - `kind`: `ui` for `apps/app` and `apps/website` (UI-heavy, skips the SQL lens); `code` for everything else.

   Keep slices reasonably sized — if a package is huge, you may pass sub-paths (e.g. `packages/oxagen/src/contracts`) as separate slices so each reviewer reads a digestible amount. Cap the total at roughly 24 slices per run to respect token and CI budgets; if there are more, run `/eval-swarm` again scoped to the remainder.

2. **Invoke the workflow** with the slices as `args`:
   ```
   Workflow({
     name: "eval-swarm",
     args: {
       slices: [ { id, path, kind }, ... ],
       repoLevel: true,   // set false to skip the repo-wide auditors
       fix: true          // set false for a report-only dry run (no remediation)
     }
   })
   ```
   Pass `args` as a real JSON object, not a string.

3. **Report back.** When the workflow returns, summarize:
   - the P0/P1 counts and the repo-wide findings count,
   - per package: what `break-fix` changed, the branch it committed to, and the report path under `docs/audits/eval-swarm/`,
   - anything left unfixed and why.

## Output artifacts
- **Per-agent / per-package reports** under `docs/audits/<agent-name>/` and `docs/audits/eval-swarm/`, each filename prefixed with the UTC timestamp at write.
- **Memories** under `.oxagen/memories/` for any durable instinct, with `_index.md` updated when the agent judges it important.
- **Committed-but-unpushed fix branches** — one per package domain. Per the repo's hard no-push rule, the swarm never pushes; Mac reviews each branch and pushes/PRs them one at a time so the pre-push test gate never runs as a concurrent herd.

## Notes
- **Review is read-only.** Lenses produce findings only; the separate Remediate phase is the only thing that edits files, and it runs in isolated git worktrees so parallel fixes can't trample each other.
- **Severity discipline.** Only P0/P1 are auto-fixed; P2/P3 are reported. Every flagged P0/P1 is verified by an independent skeptic before any fix is attempted, to kill false positives.
- For a single targeted review of the current diff instead of a full sweep, use `/code-review` or the `eval-code` agent directly.

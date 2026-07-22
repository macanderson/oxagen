---
# Repo Detail

- **Route:** `/{orgSlug}/{workspaceSlug}/workbench/repos/[connectionId]`
- **Nav location:** workspace → Workbench → tab "Repos" → row click
- **Priority:** P3
- **Disposition vs today:** New

## Purpose
The operational detail view for one connected repository — branches, pull requests, CI status, files, and active file locks — so a builder can inspect and drive repo activity, including work done concurrently by multiple code agents, without leaving the app.

## Primary user & jobs-to-be-done
- **Primary user:** agent builder / developer
- **JTBD:**
  - See repo-level metrics (sync health, PR volume, CI pass rate) at a glance
  - Create a branch and open a PR from it
  - Review a PR's diff and CI check-run status before merge
  - Commit a file directly and see the resulting diff
  - See which files are currently locked by an agent so concurrent edits don't collide

## Functionality
- Tabs: Overview (metrics) · Branches (list + Create) · Pull Requests (list → detail: diff, CI checks, Open PR) · Files (browse + commit a file) · Locks (active file locks with holder, TTL, path).
- Pull Requests tab: per-file diff viewer, CI check-run list with pass/fail/pending badges, "Open PR" action from a branch.
- Locks tab: table Path · Held by (agent/session) · Acquired at · Expires at; manual "Release" for stuck locks (admin-gated).

## Capabilities invoked
- `repo.branch.create` (`create_branch`) — Branches tab create.
- `repo.pr.open` (`open_pr`), `repo.pr.get` (`get_pr`), `repo.pr.diff` (`get_pr_diff`) — Pull Requests tab.
- `repo.ci.status` (`get_ci_status`) — CI check-run badges.
- `repo.file.put` (`put_repo_file`) — Files tab commit.
- `repo.metrics` (`get_repo_metrics`) — Overview tab.
- `agent.repo.edit` (`edit_repo_file`) — agent-driven file edits reflected in Files/PR tabs.
- `agent.file_lock.list` (`list_file_locks`), `.acquire` (`acquire_file_lock`), `.release` (`release_file_lock`) — Locks tab.

## Data sources
GitHub API via the contracts above; Postgres (file locks); ClickHouse (repo-op metering).

## States
- **Empty:** no branches/PRs yet — Overview shows zero-state metrics with a "create your first branch" CTA.
- **Loading:** per-tab skeletons so a slow CI check-run fetch doesn't block the Files tab.
- **Error:** PR diff/CI fetch failures show inline retry within that tab only; lock-release failure surfaces a toast, not a blocked page.

## Existing implementation
- **Today:** no app UI exists for any `repo.*` detail capability. Build new.

## Vision alignment
Fleet lineage and governance made concrete: concurrent agents coordinated by TTL file locks, every repo operation metered — this is where multi-agent code collaboration becomes auditable rather than a race condition.

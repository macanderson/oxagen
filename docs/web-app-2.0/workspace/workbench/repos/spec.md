---
# Repos

- **Route:** `/{orgSlug}/{workspaceSlug}/workbench/repos`
- **Nav location:** workspace → Workbench → tab "Repos"
- **Priority:** P2
- **Disposition vs today:** New (the entire `repo.*` family has zero app UI today; only the CLI covers it)

## Purpose
The list of GitHub repositories connected to this workspace via the GitHub App — sync/pause/resume control, CI and PR visibility, and the entry point for a code-agent to edit a file and open a PR. Today this whole capability family is CLI-only; this page brings it into the app so a human builder can operate repo connections without a terminal.

## Primary user & jobs-to-be-done
- **Primary user:** agent builder / developer managing code-mode agents
- **JTBD:**
  - See every connected repo, its sync status, and last index time
  - Pause/resume sync on a repo, or trigger a manual sync
  - See open PR count and CI status per repo at a glance
  - Connect a new repo (create or fork) and configure it
  - Launch a code-agent to edit a file and open a PR directly from here
  - Install or disconnect the GitHub App (moved from settings/github)

## Functionality
- Table: Repo · Sync status · Last index · Open PRs · CI status; row click → repo detail.
- Row actions: Sync now, Pause, Resume, Configure.
- Header actions: "Create repo", "Fork", "Connect GitHub App" / "Disconnect".
- "Edit file & open PR" launcher: pick repo + file path + instruction → dispatches a code agent.

## Capabilities invoked
- `repo.sync` (`sync_repo`), `repo.pause` (`pause_repo`), `repo.resume` (`resume_repo`) — row actions.
- `repo.metrics` (`get_repo_metrics`) — sync/PR/CI summary columns.
- `repo.configure` (`configure_repo`) — Configure action.
- `repo.create` (`create_repo`), `repo.fork` (`fork_repo`) — header actions.
- `connection.list` (`list_connections`, github-typed) — GitHub App install state.
- `agent.repo.edit` (`edit_repo_file`) — Edit file & open PR launcher.

## Data sources
Postgres (connection record, sync cursor — source of truth); Neo4j (code graph index, async via Inngest); ClickHouse (repo-op metering/telemetry).

## States
- **Empty:** no repos connected — CTA to install the GitHub App and connect a repo.
- **Loading:** table skeleton while `list_connections` / `get_repo_metrics` resolve.
- **Error:** sync/pause/resume failures show inline row error; GitHub App install failure surfaces a retry with a link to the app's permissions page.

## Existing implementation
- **Today:** no app UI exists; `repo.*` is reachable only via CLI. Build new — this is a net-new page, not a migration.

## Vision alignment
Metered, governed repo operations extend the accountability chain over code actions and feed the graph-grounding pillar via the Neo4j code-map index — a direct build-out of fleet lineage over source control.

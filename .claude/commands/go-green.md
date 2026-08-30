---
description: Drive a repo's main branch to green — resolve conflicts, fix CI on every open PR, monitor deploys, and verify with screenshots of main green and 0 open PRs.
argument-hint: <repo or blank for all>
allowed-tools: Bash, Read, Edit, Write, Grep, Glob, Agent, ToolSearch, TaskCreate, TaskGet, TaskList, TaskOutput, TaskStop, TaskUpdate, Monitor
---

# /go-green $ARGUMENTS

Drive the target repositories to a fully green state and prove it.

**Target:** `$ARGUMENTS`. If blank, target all of: `macanderson/stella`, `macanderson/oxagen-platform`, `macanderson/context-graph-protocol`, `macanderson/cgp-website`. A short name resolves to `macanderson/<name>`.

**Definition of done:** for every target repo — main's latest CI run is green, zero PRs remain open, any deploy triggered by a merge completed healthy, and verification screenshots exist on the Desktop. Do not stop short of that.

## Phase 1 — Survey

For each target repo (prefix `gh` with `env -u CLICOLOR_FORCE` when using `--json` — a shell env var otherwise corrupts the output):

- Main health: `gh run list --branch main --limit 5 --json workflowName,conclusion,url`
- Open PRs: `gh pr list --state open --json number,title,headRefName,mergeable`
- Per-PR checks: `gh pr checks <n>`

Dispatch one subagent per repo when more than one repo needs work — the lanes are independent.

## Phase 2 — Fix every open PR

For each open PR, work in a dedicated git worktree cut from the PR branch — never in a checkout another session may be using:

1. **Conflicts:** merge `origin/main` into the branch and resolve, preserving both sides' intent; re-run the touched packages' checks locally.
2. **Failing checks:** read the CI log, reproduce locally with the narrowest command that exercises the failure, fix the root cause. Never delete or skip a failing test, never loosen a lint rule or guard baseline to get past it.
3. **Land it:** commit with explicit file paths (never `git add -A`), push, watch checks until fully green.
4. **Merge** the green PR using the repo's convention (squash unless the repo says otherwise) — unless its description says it is blocked on a human decision; then report it and move on.

Repo guardrails that override defaults:

- **stella:** comment prose must pass `scripts/check-prose.py`; the file-size ratchet caps files at 1500 lines; a linked issue needs a fully checked "Definition of done" section before merge.
- **oxagen-platform:** never run the full test suite locally — run only the changed package's tests; `pnpm gate` is the pre-merge check.

## Phase 3 — Keep main green

After each merge, watch main's CI to conclusion (`gh run watch <id>`, then confirm with `gh run view <id> --json conclusion` — the watch pipe's exit code is `tail`'s, not the run's). If a deploy workflow runs, monitor it and verify the deployed surface responds (health endpoint or homepage 200). If main breaks, fixing it becomes the top priority: diagnose, fix forward on a branch, PR, merge, re-watch.

## Phase 4 — Verify with screenshots

For each repo, once main is green and 0 PRs are open, capture with a browser:

- The repo's main page showing the green check beside the latest commit → `~/Desktop/<repo>-main-green.png`
- The Pull requests tab showing "0 Open" → `~/Desktop/<repo>-prs-zero.png`

## Report

End with a per-repo table: main status, PRs fixed/merged (numbers), deploys verified, screenshot paths. List anything a human must decide, with links.

# propose_steering

**Domain:** context
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** mcp
**Risk level:** medium

## Intent

An agent opens a steering PR on its workspace's steering repo, without a clone. It sends the files, a title, its rationale, and frames of its run as evidence. Oxagen writes one commit on a new branch, opens the PR, and runs the steering checks as the "Oxagen steering" check. Nothing steers an agent until a person merges the PR.

Oxagen writes each record's `provenance`: `source: proposal`, the run as `uri` (`oxagen:run/<run>`), and the proposing agent as `agent`. The agent is the one the MCP server's gateway key and session header resolve to, by the `agents/<name>.toml` file on the run's runtime in the published steering. No tool input names it, so an agent cannot propose under another agent's name. Oxagen writes `id` and `hash` when the PR merges.

The branch starts with the folder the files change: `steering/`, `tools/`, `agents/`, or `policy/`, `workspace/` for a file at the repository root, and `memory/` for `steering/memory/`. It is named `<folder>/propose-<what>-<time>`, such as `steering/propose-aintel.billing.refunds-over-100-20261002t153012`. A `steering/`, `agents/`, `policy/`, or `workspace/` PR changes one thing: one record, one skill folder, one agent, one policy group, or one root file.

The steering repo spec proposed the name `steering_propose`. ADR-025 puts the verb first.

## Input

| Field | Type | Notes |
|---|---|---|
| `title` | `string` (1–200) | The PR's title. |
| `rationale` | `string` (1–4000) | Why the change should merge. The PR body shows it. |
| `evidence` | `int[]` (≤20) | Frame numbers in this run. The PR body cites each as `frame:<run>/<n>`. Defaults to none. |
| `files` | `{ path, content }[]` (1–299) | Each file to write, or to delete when `content` is null. `path` is relative to the repository root, at most 512 characters. `content` is UTF-8 text, at most 1 MB. |

## Output

| Field | Type | Notes |
|---|---|---|
| `number` | `int` | The PR's number. |
| `url` | `string` | The PR's page on GitHub or GitLab. |
| `branch` | `string` | The branch the PR merges. |
| `head_sha` | `string` | The commit the PR opened at, which the steering checks ran on. |
| `agent` | `string` | The agent Oxagen wrote into each record's provenance. |
| `run` | `string` | The run Oxagen wrote into each record's provenance. |

## Refusals

| Code | Reason | When |
|---|---|---|
| `forbidden` | `no_proposing_agent` | The request resolves to no agent: it carries no gateway key, its machine has no runtime, the workspace has published no steering, or no agent file matches the runtime and harness. |
| `forbidden` | `no_watched_run` | The request names no run Oxagen recorded on the key's machine. |
| `forbidden` | `provenance_claimed` | A record sets `provenance.agent`, or `provenance.source: run`. |
| `conflict` | `oxagen_owned_path` | A file is `policy/schema.cedarschema`, a server's `tools.lock.json`, or under `steering/promotions/`. |
| `conflict` | `record_identity_typed` | A record types `id` or `hash`. |
| `conflict` | `record_unreadable` | A record's frontmatter does not read, so Oxagen cannot write its provenance. |
| `conflict` | `branch_scope` | A file is outside every folder a steering PR may change, the files span more than one folder, or a one-change PR changes more than one thing. |
| `conflict` | `managed_block_owned` | A change edits, rewrites, or removes the managed block in `AGENTS.md`, `CLAUDE.md`, or `README.md`, or deletes a file that holds one. |
| `conflict` | `no_files`, `too_many_files`, `duplicate_path` | The files are empty, more than 299, or name one path twice. |
| `conflict` | `propose_branch_exists` | The branch already exists. Call again. |
| `conflict` | `steering_repo_required` | The workspace's repository has no `steering/governance.toml`. |

The steering checks report everything else, such as a schema error or a reference to a tool that does not exist, on the PR.

## Roles

Org Owner, Org Admin, Workspace Owner, Workspace Member. A gateway key acts with the roles its creator holds now.

## Side effects

One branch, one commit, and one PR on the workspace's steering repo, and one "Oxagen steering" check run on the PR's head. Not billed (`noBillingGate: true`).

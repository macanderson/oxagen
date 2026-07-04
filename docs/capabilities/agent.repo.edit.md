# agent.repo.edit

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, agent
**Risk level:** high

## Intent

Use the coding agent to edit files in a connected GitHub repository and open a pull request with the changes. The agent runs a bounded coding loop against the repo from a base branch, pushes its changes to a working branch, and opens a PR.

## Input

| Field | Type | Notes |
|---|---|---|
| `owner` | `string` | GitHub organisation or user that owns the repository. |
| `repo` | `string` | Repository name (without the owner prefix). |
| `instruction` | `string` (≥10) | Natural-language coding instruction for the agent. |
| `baseBranch?` | `string` | Branch to base the changes on (defaults to `main` when omitted). |
| `branchName?` | `string` | Branch name to push the agent's changes to (auto-generated when omitted). |
| `model?` | `string` | Vercel AI Gateway model id, e.g. `anthropic/claude-opus-4-8`. |
| `maxSteps?` | `int 1–40` | Maximum coding-loop steps the agent may execute (default `12`). |

## Output

| Field | Type | Notes |
|---|---|---|
| `prNumber` | `number` | Pull request number opened by the agent. |
| `prUrl` | `string` | HTML URL of the pull request. |
| `branch` | `string` | Branch the agent's changes were pushed to. |
| `changedFiles` | `string[]` | Relative paths of every file changed by the agent. |
| `summary` | `string` | Final response text from the coding agent. |

## Roles

Org Owner, Org Admin, Workspace Owner, Workspace Member.

## Side effects

- GitHub: pushes a branch and opens a pull request against the connected repository.
- ClickHouse: emits coding-agent execution/telemetry events (steps, tokens, duration).

## Errors

| code | meaning |
|---|---|
| `validation_error` | Input failed Zod parse (e.g. instruction under 10 characters). |
| `not_found` | The repository is not connected or not accessible in this workspace. |
| `unauthorized` | Caller lacks the required org/workspace role. |

# CLI Gap Analysis — `@oxagen/cli`

**Audited:** 2026-06-24  
**Auditor:** Architecture review (read-only pass, no Bash execution)

---

## Executive Summary

The CLI is in generally good shape: 134 command source files exist, all are imported and registered in `index.tsx`, and the error-handling pattern is largely consistent. However, five categories of issues need attention.

**Headline numbers:**

| Metric                                                              | Count       |
| ------------------------------------------------------------------- | ----------- |
| Command files on disk (in `src/commands/**/*.ts`, excl. test files) | 134         |
| Commands registered in `index.tsx`                                  | 134 (100%)  |
| Orphaned command files (disk but not registered)                    | 0           |
| Broken imports (import but file missing)                            | 0           |
| Contracts with `cli` in `surfaces[]` but no CLI command             | ~15         |
| Commands missing `requireAuth()` call                               | ~100 of 134 |
| Commands with `--json` output flag                                  | 15 of 134   |
| Commands with usage examples (`.addHelpText`)                       | 1 of 134    |
| Commands identified as stubs                                        | 0           |

**Top-5 gaps:**

1. No `integration.*` CLI commands despite 6 contracts with `cli` in surfaces.
2. No `repo.*` CLI commands despite 4 contracts with `cli` in surfaces.
3. `graph edge upsert` targets the deprecated `graph.edge.upsert` contract with a hardcoded 8-type enum; the live contract is `graph.relationship.upsert` with a regex-validated free type.
4. `~100` commands silently omit `requireAuth()`, giving late, opaque network errors on unauthenticated runs.
5. `--json` flag missing from 119 of 134 commands — commands cannot be used in CI/scripting pipelines.

---

## Registration Gaps

**Registration drift: none.** Every file on disk is imported and registered. No orphaned files. No broken imports.

The Glob on `src/commands/**/*.ts` returns 135 paths (including 1 test file, `__tests__/cli-parity.test.ts`, and 1 command-level test file `privacy.erase.test.ts`). The 134 non-test `.ts` files each export at least one `Command` object. All 134 are imported in `index.tsx` lines 6–140 and wired to the program hierarchy.

**Structural notes on grouping:**

| Group                            | Nesting                                                                                                          | Note                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `org create` vs `org create-org` | Both under `org`                                                                                                 | **Duplicate.** `org.create.ts` (name: `"create"`, calls `/organizations`) and `organization.create.ts` (name: `"create-org"`, calls `/organization/create`) both sit under the `org` command. Two separate commands with overlapping purpose — one should be removed or the other renamed as the canonical flow.                                                                                                                                                                                |
| `user preferences`               | get/update/read/write — all four under `user preferences`                                                        | **Duplication of intent.** `user.preferences.get` + `user.preferences.update` predate `user.preferences.read` + `user.preferences.write`. The latter pair maps to the live contracts (`user.preferences.read`, `user.preferences.write`). The former pair (`get`/`update`) hits different API endpoints (`/user/preferences/get`, `/user/preferences/update`) and carry different fields. Only the `read`/`write` pair is contract-matched; the `get`/`update` pair appears to be legacy/drift. |
| `graph edge` sub-group           | `graph.command("edge")` → `edge-upsert` + `delete`                                                               | `graphEdgeUpsertCommand.name()` is `"edge-upsert"` — so the full path is `oxagen graph edge edge-upsert` (redundant word). Should be `oxagen graph edge upsert`.                                                                                                                                                                                                                                                                                                                                |
| `schema` sub-group               | `schemaLabelCommand` contains both `upsert` and `delete`; same for `rel` and `prop`                              | Multi-command files. These work correctly but the nesting is correct.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `plugin.workspace.set_enabled`   | Registered under `pluginOrg` (line 225 of `index.tsx`): `pluginOrg.addCommand(pluginWorkspaceSetEnabledCommand)` | **Misrouted.** This is a workspace-level operation but sits under `plugin org`. It should live under a `plugin workspace` subcommand group.                                                                                                                                                                                                                                                                                                                                                     |

---

## Capability Parity Gaps

The parity rule requires: contract → API route → MCP tool → CLI command. The `surfaces[]` field in each contract is authoritative. Below are contracts where `"cli"` appears in `surfaces[]` but no CLI command exists.

### Missing: Integration domain (~6 commands)

All 6 contracts below have `surfaces: ["api", "mcp", "cli", "agent"]`:

| Contract                | Expected CLI path              |
| ----------------------- | ------------------------------ |
| `integration.list`      | `oxagen integration list`      |
| `integration.get`       | `oxagen integration get`       |
| `integration.install`   | `oxagen integration install`   |
| `integration.configure` | `oxagen integration configure` |
| `integration.delete`    | `oxagen integration delete`    |
| `integration.sync`      | `oxagen integration sync`      |

Source: `packages/oxagen/src/contracts/integration.*.ts`, all declare `surfaces: ["api", "mcp", "cli", "agent"]`.

### Missing: Repo domain (~4 commands)

All 4 contracts have `surfaces: ["api", "mcp", "cli", "agent"]`:

| Contract         | Expected CLI path       |
| ---------------- | ----------------------- |
| `repo.sync`      | `oxagen repo sync`      |
| `repo.configure` | `oxagen repo configure` |
| `repo.pause`     | `oxagen repo pause`     |
| `repo.resume`    | `oxagen repo resume`    |

Source: `packages/oxagen/src/contracts/repo.*.ts`.

### Missing: Graph relationship upsert (1 command)

`graph.relationship.upsert` has `surfaces: ["api", "mcp", "agent", "cli"]` (`packages/oxagen/src/contracts/graph.relationship.upsert.ts:14`).  
Expected CLI path: `oxagen graph relationship upsert`  
Status: **No CLI command.** The existing `graph edge upsert` command is mapped to the deprecated `graph.edge.upsert` contract (see Stubs section).

### Missing: Schema setup/recommend/validate (~4 commands)

| Contract                       | Surfaces include `cli`?                                                  | Expected CLI path                     |
| ------------------------------ | ------------------------------------------------------------------------ | ------------------------------------- |
| `schema.setup`                 | Yes (`packages/oxagen/src/contracts/schema.setup.ts:10`)                 | `oxagen schema setup`                 |
| `schema.recommend`             | Yes (`packages/oxagen/src/contracts/schema.recommend.ts:10`)             | `oxagen schema recommend`             |
| `schema.validate.node`         | Yes (`packages/oxagen/src/contracts/schema.validate.node.ts:10`)         | `oxagen schema validate node`         |
| `schema.validate.relationship` | Yes (`packages/oxagen/src/contracts/schema.validate.relationship.ts:10`) | `oxagen schema validate relationship` |

### Approximate total CLI-surfaced gap count

Contracts with `cli` in `surfaces[]`: 48 (grep count from `packages/oxagen/src/contracts/`).  
CLI commands that satisfy them: ~33 (all schema, graph node/edge/cypher, ontology, automation, and other covered capabilities).  
Net gap: **~15 contracts** have `cli` in their surfaces declaration but no corresponding CLI command.

### Additional parity observations (contracts without `cli` in surfaces but with CLI commands)

These represent CLI commands that exist but the contracts don't list them as CLI-surfaced — a signal that either the CLI command predates the contract's `surfaces` annotation being updated, or the CLI command was added without updating the contract:

- `api.key.create` (`surfaces: ["api", "mcp", "agent"]`) — CLI command exists at `apps/cli/src/commands/api-key.create.ts`
- `api.key.revoke` (`surfaces: ["api", "mcp"]`) — CLI command exists
- `conversation.chat` (`surfaces` should be checked) — CLI command exists

These are lower priority but should be resolved: either add `"cli"` to the `surfaces[]` of each contract (to properly declare the CLI as a supported surface), or remove the CLI command if it is unintentional.

---

## `--help` Documentation Gaps

### 1. No usage examples — 133 of 134 commands

`addHelpText("after", ...)` is used in exactly one command (`apps/cli/src/commands/schema/schema.prop.ts`). Every other command shows only the auto-generated option list with no example invocations. For complex commands (graph upsert, automation create, schema reconcile), this severely hinders discoverability.

**Fix needed:** Add `.addHelpText("after", "\nExamples:\n  ...")` to all commands, or at minimum to high-complexity ones.

### 2. Missing `requireAuth()` in ~100 commands

`requireAuth()` is called in only 34 of 134 command files. The remaining ~100 make `apiRequest()` directly without first validating that a token is configured. `apiRequest()` does not exit early on missing tokens — it sends the request and the server returns a 401/403. The user sees a raw HTTP error rather than the actionable message: `"Error: not authenticated. Run \`oxagen auth login\` first."`.

**Affected pattern (representative examples, not exhaustive):**

- `apps/cli/src/commands/graph.node.upsert.ts` — no `requireAuth()` call
- `apps/cli/src/commands/graph.node.get.ts` — no `requireAuth()` call
- `apps/cli/src/commands/agent.memory.recall.ts` — no `requireAuth()` call
- `apps/cli/src/commands/video.generate.ts` — no `requireAuth()` call
- `apps/cli/src/commands/workflow.run.ts` — no `requireAuth()` call

Conversely, schema commands (`apps/cli/src/commands/schema/*.ts`) and ~20 other core commands do call `requireAuth()` correctly at the top of their action handlers, following the canonical pattern from `auth.whoami.ts`.

**Fix needed:** Add `requireAuth()` as the first call in the `.action()` of every command that reaches out to the API.

### 3. `graph edge upsert` name is `"edge-upsert"`, not `"upsert"`

`apps/cli/src/commands/graph.edge.upsert.ts:15`: `new Command("edge-upsert")`.  
Registered under `graph.command("edge")` → creates path `oxagen graph edge edge-upsert`.  
Canonical path should be `oxagen graph edge upsert`.  
Every other command uses a verb name (`"upsert"`, `"delete"`, `"list"`) when nested — this is the only exception.

### 4. Inconsistent error message formatting

Two patterns appear:

- **Pattern A (preferred):** `const msg = err instanceof ApiError ? err.message : String(err); console.error(\`Error: ${msg}\`);` — used in ~80 commands.
- **Pattern B (non-standard):** `console.error("Failed to get graph node:", error);` — used in graph commands (`graph.node.get.ts:17`, `graph.node.upsert.ts:34`, `graph.node.search.ts`, `agent.memory.recall.ts:20`, `video.generate.ts:24`, etc.). This pattern logs the raw Error object and skips the `ApiError` check, producing verbose stack-trace output on errors.

**Fix needed:** Standardize all commands on Pattern A (ApiError check + `Error: ${msg}` prefix).

### 5. Inline error handler on single line — `auth.whoami.ts:22`, `auth.login.ts:34`, `billing.status.ts:34`, `org.create.ts:22`, `api-key.create.ts:34`

Several files have the error handler collapsed onto one line:

```
const _msg = err instanceof ApiError ? err.message : String(err); console.error(`Error: ${_msg}`);
```

This is a linting concern (multiple statements per line) and makes the code harder to read. Should be split across lines.

### 6. Root program description is minimal

`apps/cli/src/index.tsx:146`: `.description("Oxagen developer CLI")`.  
`oxagen --help` only shows this short description. There is no version preamble, no concept overview, and no "Getting started" hint. A more descriptive blurb with `addHelpText("beforeAll", ...)` would help first-time users.

### 7. Group commands lack rich descriptions

Several group commands have terse descriptions:

- `agent`: `"Agent commands"` — too generic
- `skill`: `"Skill management commands"` — acceptable but could note the skill.md format
- `documents`: `"Document generation commands"` — duplicate of `document` (singular); the distinction is unclear from help text

---

## Stubs and Incomplete Commands

| File                                                                           | Issue                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Severity                                                              |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `apps/cli/src/commands/graph.edge.upsert.ts`                                   | Uses a hardcoded 8-type enum (`RELATED_TO`, `PART_OF`, etc.) and sends `edgeType` to `/graph/edges`. The live `graph.edge.upsert` contract is marked `@deprecated` in `packages/oxagen/src/contracts/graph.edge.upsert.ts:1` with a comment to use `graph.relationship.upsert` instead. The CLI command targets the deprecated contract and would reject valid workspace-defined relationship types.                                                                                        | High — functional regression for users with custom relationship types |
| `apps/cli/src/commands/user.preferences.get.ts` + `user.preferences.update.ts` | These predate the `user.preferences.read` / `user.preferences.write` contracts (which map to distinct API endpoints). Both the old and new commands are registered under `user preferences`, creating four overlapping subcommands (`get`, `update`, `read`, `write`). The `get`/`update` pair hits `/user/preferences/get` and `/user/preferences/update`; the `read`/`write` pair hits `/user/preferences/read` and `/user/preferences/write`. It is unclear which pair is authoritative. | Medium — UX confusion, potential endpoint drift                       |
| `apps/cli/src/commands/organization.create.ts`                                 | Exposes `oxagen org create-org` alongside `oxagen org create`. Both create an organization. The `org.create.ts` command hits `/organizations` (Better Auth path); `organization.create.ts` hits `/organization/create` (Oxagen API path). These appear to be duplicate coverage of the same user action with no differentiation in `--help`.                                                                                                                                                | Medium — confusing duplication                                        |

---

## Other Gaps

### 1. No `--json` output on 119 of 134 commands

Only 15 command files support `--json` output (all 11 in `schema/`, plus `web.fetch.ts`, `web.search.ts`, `skill.metrics.read.ts`, `chat.send.ts`). All other commands print human-readable text with no structured output option. This makes the CLI unusable in CI pipelines, shell scripts, or downstream tools that need to parse results.

`--json` should be standard on any command that returns data (list, get, read, status). High-priority candidates: `org list`, `workspace list`, `conversation list`, `graph node get`, `graph node search`, `billing status`, `workflow status`, `agent skill list`, `audit log query`.

### 2. No global `--org` / `--workspace` flags on the root program

`config.ts` reads `OXAGEN_ORG_ID` and `OXAGEN_WORKSPACE_ID` from the environment (and `orgSlug`/`workspaceSlug` from the config file). However, there is no global `-o, --org <slug>` or `-w, --workspace <slug>` flag on the root `program` object that would override the current context for a single command invocation.

Each individual command that needs an org/workspace ID re-implements its own local `--org` or `-w, --workspace` option (e.g. `workflow.run.ts:15`, `billing.status.ts:18`), with inconsistent flag names and inconsistent defaults. Some commands use `getOrgId()` as a fallback, some hardcode a query param, some omit the option entirely.

**Recommended fix:** Add `--org <slug>` and `--workspace <slug>` as global options on `program` in `index.tsx`, and have them populate env vars (`OXAGEN_ORG_ID`, `OXAGEN_WORKSPACE_ID`) before command dispatch. Remove per-command duplicates.

### 3. Test coverage structure

`apps/cli/src/commands/__tests__/cli-parity.test.ts` tests that 14 specific command objects are defined and have the correct `.name()`. This is a shallow existence check. It does not test command logic, option parsing, API request shapes, or error handling.

`apps/cli/src/commands/privacy.erase.test.ts` is a well-structured unit test with mocked `apiRequest` and full action coverage — it is the exception, not the rule.

Of 134 command files, only 2 have test coverage (the parity smoke test covers 14, `privacy.erase` has a proper unit test). The remaining 120+ commands have no unit tests.

**Structural concern:** Having `cli-parity.test.ts` in `commands/__tests__/` while `privacy.erase.test.ts` lives next to its source (`commands/privacy.erase.test.ts`) is inconsistent. Pick one convention.

### 4. `schema.reconcile.ts` — `requireAuth()` is called but `schema.config.ts` etc. don't suppress duplicate calls

Minor: the schema subcommand files call `requireAuth()` inside the `action()` handlers, which is correct. However, the parent `schemaCmd` group command in `index.tsx` has no pre-hook that would call `requireAuth()` once. This is fine architecturally (each leaf command is responsible), but an engineer adding a new schema command might forget.

### 5. No `--profile` or multi-tenant context switching

Users working across multiple orgs and workspaces have no way to maintain named config profiles (e.g. `--profile production`). The config file is a single JSON at `~/.config/oxagen/config.json`. Multi-tenant use requires manual `OXAGEN_ORG_ID`/`OXAGEN_WORKSPACE_ID` env var exports.

---

## Prioritized Fix Plan

### P0 — Correctness / Breaking

| #    | What                                                                                                                                                                                                                                                                                        | Where                                                                                                                     | Effort |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------ |
| P0-1 | Replace deprecated `graph.edge.upsert` CLI command with a `graph relationship upsert` command targeting the live `graph.relationship.upsert` contract and `/graph/relationship/upsert` endpoint. Remove the hardcoded 8-type enum. Fix the command name from `"edge-upsert"` to `"upsert"`. | `apps/cli/src/commands/graph.edge.upsert.ts` → rename to `graph.relationship.upsert.ts`; update `index.tsx` lines 378–380 | S      |
| P0-2 | Add `requireAuth()` as the first call in every command `.action()` that was missing it (~100 files). Consistent early-exit with actionable message.                                                                                                                                         | Every command file not in the list of 34 that already calls it                                                            | M      |

### P1 — Parity / User-Facing Gaps

| #    | What                                                                                                                                                                                                                                                                                           | Where                                                                                                               | Effort |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------ |
| P1-1 | Add 6 `integration.*` CLI commands (`integration list`, `get`, `install`, `configure`, `delete`, `sync`)                                                                                                                                                                                       | New files: `apps/cli/src/commands/integration.*.ts`; register in `index.tsx`                                        | M      |
| P1-2 | Add 4 `repo.*` CLI commands (`repo sync`, `configure`, `pause`, `resume`)                                                                                                                                                                                                                      | New files: `apps/cli/src/commands/repo.*.ts`; register in `index.tsx`                                               | S      |
| P1-3 | Add `graph relationship upsert` CLI command (separate from the deprecated edge command)                                                                                                                                                                                                        | `apps/cli/src/commands/graph.relationship.upsert.ts`; register under `graph.command("relationship")` in `index.tsx` | XS     |
| P1-4 | Add `schema setup`, `schema recommend`, `schema validate node`, `schema validate relationship` CLI commands                                                                                                                                                                                    | `apps/cli/src/commands/schema/schema.setup.ts` etc.; register in `index.tsx` schema block                           | S      |
| P1-5 | Add `--json` flag to all data-returning commands. Priority order: org list, workspace list, conversation list/delete, graph node get/search, billing status, workflow status, audit log query (the audit log query already has `--json` via MCP contract), agent skill list, api-key commands. | ~40 high-priority command files                                                                                     | L      |

### P2 — Quality / Developer Experience

| #    | What                                                                                                                                                                                                 | Where                                                                                                               | Effort |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------ |
| P2-1 | Resolve `org create` / `org create-org` duplication. Keep one authoritative command, remove the other.                                                                                               | `apps/cli/src/commands/org.create.ts` and `organization.create.ts`; `index.tsx` line 174                            | XS     |
| P2-2 | Resolve `user preferences get`/`update` vs `read`/`write` duplication. Determine which pair is contract-authoritative, deprecate or remove the other.                                                | `apps/cli/src/commands/user.preferences.{get,update,read,write}.ts`; `index.tsx` lines 288–291                      | XS     |
| P2-3 | Move `plugin.workspace.set_enabled` from under `plugin org` to a `plugin workspace` group.                                                                                                           | `index.tsx` line 225 (`pluginOrg.addCommand(pluginWorkspaceSetEnabledCommand)` → `pluginWorkspace.addCommand(...)`) | XS     |
| P2-4 | Standardize error handling across all commands: replace Pattern B (`console.error("Failed to X:", error)`) with Pattern A (ApiError check + `Error: ${msg}`).                                        | `apps/cli/src/commands/graph.node.*.ts`, `agent.memory.recall.ts`, `video.generate.ts`, and ~10 others              | XS     |
| P2-5 | Add usage examples via `.addHelpText("after", ...)` to all commands, starting with complex ones: `graph node upsert`, `automation create`, `schema reconcile`, `research swarm start`.               | All command files                                                                                                   | L      |
| P2-6 | Add global `--org <slug>` and `--workspace <slug>` options to the root `program`; remove per-command duplicates. Update `config.ts` to consume them.                                                 | `apps/cli/src/index.tsx`; `apps/cli/src/lib/config.ts`; all per-command `--org`/`--workspace` options               | M      |
| P2-7 | Expand test coverage: add unit tests for at minimum the top-20 most-used commands, following the `privacy.erase.test.ts` pattern (mock `apiRequest`/`requireAuth`, assert request shape and output). | New test files alongside each command                                                                               | L      |
| P2-8 | Update contracts that have CLI commands but don't list `"cli"` in `surfaces[]`: add `"cli"` to `api.key.create`, `api.key.revoke`, and any others.                                                   | `packages/oxagen/src/contracts/api.key.create.ts:22`; `api.key.revoke.ts:16`                                        | XS     |
| P2-9 | Enrich root program description and add a getting-started `addHelpText` block for first-time users.                                                                                                  | `apps/cli/src/index.tsx` lines 144–147                                                                              | XS     |

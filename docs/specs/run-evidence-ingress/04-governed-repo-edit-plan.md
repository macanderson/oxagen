# Governed Repository Edit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the synchronous, caller-addressed repository editor with one agent-only asynchronous admission path whose root or child run is bound to a verified GitHub repository snapshot, executes only in a sandbox, and produces complete runner/provider evidence.

**Architecture:** A kernel-created deployed-agent invocation context or existing deployed-agent run invokes `edit_repo_file`. The handler admits a root or narrowed child `RunSpecV2` from server-resolved actor, authorization, repository, retention, and engine policy; it returns the run handle immediately. The durable worker creates the sandbox, executes code mode, verifies changes, and publishes through an exact GitHub connection. The legacy API/MCP/UI launcher and GitHub-API workspace fallback are deleted atomically with the contract cutover.

**Tech Stack:** TypeScript 6, Zod 3, Vitest, PostgreSQL/Drizzle, durable agent worker, capability kernel, Modal sandbox, GitHub App API.

## Global Constraints

- This plan consumes the repository-binding, `RunSpecV2`, attempt, IAM, and evidence-finalization primitives from PR 1A, PR 1B, and PR 2. It does not recreate them.
- The launch input is exactly `{ instruction }`. Owner, repository, connection, base ref, branch name, model, max steps, environment, identity, and retention are trusted host policy or parent-run bindings.
- Admission never waits for the durable worker. The output is `{ runId, status: "pending" }`, preventing worker-pool deadlock.
- A root run uses a kernel-created `DeployedAgentInvocationContext` and `parent_run_id = null`. A child copies and narrows the parent human/agent ceiling; it cannot widen grants, choose another repository, or outlive a parent revocation.
- GitHub repository identity is the immutable provider repository ID. Owner/name/default-ref strings are provider-observed annotations.
- Governed edits require an isolated sandbox pinned to base commit and tree. Sandbox unavailability fails the attempt; it never chooses `GitHubWorkspace`.
- Branch, commit, tree, pull-request, and check identities come from provider responses or follow-up reads. Do not synthesize successful receipts.
- No direct human/API/MCP/app action can invoke the launch contract.
- `RUN_EVIDENCE_REPO_EDIT_ENABLED` is false by default. A disabled handler fails with a typed unavailable result and does not admit a run.

---

## Task 1: Persist Verified GitHub Repository Bindings

**Files:**

- Modify: `packages/github/src/types.ts`
- Modify: `packages/github/src/fetch-client.ts`
- Modify: `packages/github/src/__tests__/fetch-client-read.test.ts`
- Modify: `packages/github/src/__tests__/fetch-client.test.ts`
- Modify: `apps/api/src/routes/v1/github-oauth.ts`
- Modify: `apps/api/src/__tests__/github-oauth.test.ts`
- Modify: `apps/app/src/components/knowledge/connections/github-connection-wizard-types.ts`
- Modify: `apps/app/src/components/knowledge/connections/github-connection-wizard-step2.tsx`
- Modify: `apps/app/src/components/knowledge/connections/github-connection-wizard-step2.test.tsx`
- Modify: `apps/app/src/components/knowledge/connections/github-connection-wizard-step3.tsx`
- Modify: `apps/app/src/components/knowledge/connections/github-connection-wizard.tsx`
- Modify: `apps/app/src/components/knowledge/connections/github-connection-wizard.test.tsx`
- Modify: `packages/handlers/src/connection.mappings.set.ts`
- Modify: `packages/handlers/src/connection.mappings.set.test.ts`
- Modify: `packages/oxagen/src/contracts/connection.mappings.set.ts`
- Modify: `packages/oxagen/src/contracts/connection.mappings.set.test.ts`
- Modify: `packages/oxagen/capabilities.manifest.json`
- Modify: `packages/database/storage-manifest.json`

- [ ] Write GitHub-client tests first for a `GitHubRepositorySnapshot` containing provider repository ID, owner, name, full name, HTML URL, configured default ref, commit SHA, tree SHA, and observation time.
- [ ] Add `resolveRepositorySnapshotById({ providerRepositoryId, configuredDefaultRef })` using the exact installation token. Fetch repository metadata by immutable provider ID, verify the configured full ref, then resolve ref → commit → tree. Owner/name cannot select the repository, and no missing ref becomes `main`.
- [ ] Make repository-list responses carry GitHub's numeric repository ID and provider default branch. Treat both as untrusted UI display until the server re-resolves them with the installation token.
- [ ] Change the wizard selection type from `{ fullName, defaultBranch }` to `{ providerRepositoryId, fullName, configuredDefaultRef }`; remove Step 3's missing-branch fallback and require an explicit governed-primary repository when more than one is selected.
- [ ] In `connection.mappings.set`, re-list/re-fetch every selected provider repository through the authenticated installation and insert immutable/versioned binding rows from PR 1A. A rename or default-ref reconfiguration creates a new version and advances its head pointer; it never edits an admitted binding.
- [ ] Set the explicit governed-primary selection. One selected repository may become primary automatically; multiple selected repositories without a chosen primary fail with a typed ambiguity error.
- [ ] Keep `deliveryConfig.selectedRepos` only as migration-compatible ingestion configuration. Security-sensitive admission reads only the normalized binding table.
- [ ] Cover multiple repositories per source connection, missing primary selection, renamed repositories with the same provider ID, versioned default-ref change, removed installation access, and duplicate selections.
- [ ] Run `pnpm --filter @oxagen/github test:unit -- fetch-client-read.test.ts`; expect pass.
- [ ] Run `pnpm --filter @oxagen/github test:unit -- fetch-client.test.ts`; expect pass.
- [ ] Run `pnpm --filter @oxagen/handlers test:unit -- connection.mappings.set.test.ts`; expect pass.
- [ ] Run `pnpm --filter @oxagen/app test:unit -- github-connection-wizard-step2.test.tsx github-connection-wizard.test.tsx`; expect pass.
- [ ] Run `pnpm check:manifest && pnpm schema:manifest && pnpm schema:manifest:check`; expect pass after regenerating both canonical manifests.
- [ ] Commit: `feat(github): persist verified repository identities`

## Task 2: Resolve Exact Connection Credentials Without a PAT Fallback

**Files:**

- Modify: `packages/github/src/workspace-token.ts`
- Create: `packages/github/src/workspace-token.test.ts`
- Modify: `packages/handlers/src/lib/github-token.ts`
- Create: `packages/handlers/src/lib/github-token.test.ts`

- [ ] Write tests proving the governed resolver requires an exact active connection plus immutable repository-binding version in the current org/workspace.
- [ ] Add `resolveGitHubTokenForBinding(scope, repositoryBindingId)` in `@oxagen/github`. It resolves the binding's exact connection, may decrypt only that credential, and verifies provider repository access by ID.
- [ ] Keep any process-PAT helper explicitly named and limited to non-governed development callers. The durable driver imports only the `@oxagen/github` binding resolver and has no import path to the legacy handlers wrapper or PAT fallback.
- [ ] Fail closed for revoked installation access, deleted connection, workspace mismatch, missing credential, and a repository moved to another installation.
- [ ] Run `pnpm --filter @oxagen/github test:unit -- workspace-token.test.ts`; expect pass.
- [ ] Run `pnpm --filter @oxagen/handlers test:unit -- github-token.test.ts`; expect pass.
- [ ] Commit: `fix(github): bind governed credentials to one connection`

## Task 3: Atomically Cut Over Agent-Only Admission and Delete Bypasses

**Files:**

- Modify: `packages/oxagen/src/contracts/agent.repo.edit.ts`
- Modify: `packages/handlers/src/agent.repo.edit.ts`
- Modify: `packages/handlers/src/__tests__/agent.repo.edit.test.ts`
- Modify: `packages/handlers/src/register.ts`
- Modify: `packages/oxagen/src/capability-meta.ts`
- Modify: `packages/oxagen/src/capability-meta.test.ts`
- Modify: `packages/agent/src/runtime/materialize-tools.ts`
- Modify: `packages/agent/src/runtime/materialize-tools.test.ts`
- Modify: `apps/api/src/routes/v1/chat.stream.ts`
- Modify: `apps/api/src/__tests__/chat.stream.test.ts`
- Modify: `packages/handlers/vitest.config.ts`
- Modify: `packages/config/src/env.ts`
- Modify: `packages/config/src/env.test.ts`
- Modify: `packages/config/src/registry.ts`
- Modify: `packages/config/src/registry.test.ts`
- Modify: `.env.example` via `pnpm env:check --write`
- Modify: `packages/oxagen/capabilities.manifest.json` via the canonical manifest generator/check workflow
- Modify: `packages/database/storage-manifest.json`
- Delete: `apps/mcp/src/tools/agent.repo.edit.ts`
- Modify: `apps/mcp/src/tools/repo.file.put.ts`
- Modify: `apps/mcp/src/tools/repo.branch.create.ts`
- Modify: `apps/mcp/src/tools/repo.pr.open.ts`
- Modify: `apps/api/src/routes/v1/repo.ts`
- Modify: `apps/api/src/__tests__/routes.agent-extended.test.ts`
- Modify: `apps/app/src/lib/workbench/repos.ts`
- Modify: `apps/app/src/lib/workbench/repos.test.ts`
- Modify: `apps/app/src/app/[orgSlug]/[workspaceSlug]/workbench/repos/actions.ts`
- Modify: `apps/app/src/app/[orgSlug]/[workspaceSlug]/workbench/repos/actions.test.ts`
- Modify: `apps/app/src/app/[orgSlug]/[workspaceSlug]/workbench/repos/repo-drawers.tsx`
- Modify: `apps/app/src/app/[orgSlug]/[workspaceSlug]/workbench/repos/repo-drawers.test.tsx`
- Modify: `apps/app/src/app/[orgSlug]/[workspaceSlug]/workbench/repos/repos-client.tsx`
- Modify: `apps/app/src/app/[orgSlug]/[workspaceSlug]/workbench/repos/repos-client.test.tsx`
- Modify: `apps/app/src/components/chat/composer-pr-status-chip.tsx`
- Modify: `apps/app/src/components/chat/composer-pr-status-chip.test.tsx`
- Modify: `apps/app/capability-ui-map.json`
- Modify: `apps/app/e2e/workbench-repos.spec.ts`
- Modify: `packages/oxagen/src/contracts/repo.file.put.ts`
- Modify: `packages/oxagen/src/contracts/repo.branch.create.ts`
- Modify: `packages/oxagen/src/contracts/repo.pr.open.ts`
- Modify: `packages/oxagen/src/contracts/__tests__/github-contracts.test.ts`
- Modify: `docs/capabilities/agent.repo.edit.md`
- Modify: `docs/capabilities/_index.md`
- Modify: `docs/web-app-2.0/workspace/workbench/repos/spec.md`
- Modify: `docs/web-app-2.0/workspace/workbench/repos/repo/spec.md`

- [ ] Rewrite the existing test first and confirm it fails against today's sync API/MCP schema, caller owner/repo/base branch, default-main behavior, and direct execution. The green contract is `mode: "async"`, `surfaces: ["agent"]`, no API/MCP/app layers, high sensitivity, default deny, input `{ instruction: string }`, output `{ runId: arun_…, status: "pending" }`.
- [ ] Preserve the ADR-025 internal artifact names `agent.repo.edit.ts`; `edit_repo_file` remains the public capability name. Do not create broad wildcard/docs/manifest churn by renaming internal files.
- [ ] Add `RUN_EVIDENCE_REPO_EDIT_ENABLED=false` to the environment registry. When false, the handler returns typed unavailable before resolving identity or enqueuing; regenerate `.env.example` from the registry.
- [ ] Wire one real root producer: when the authenticated API chat path resolves its active deployed agent/version/checksum, create PR 1A's `DeployedAgentInvocationContext` from the initiating principal and pass it only to that agent's tool materializer. Missing/inactive deployment yields no `edit_repo_file` tool; it never falls back to a human context or `agent.parentUserId`.
- [ ] Accept either that kernel-created `ctx.agentInvocation` or a complete `ctx.agentRun`; reject ordinary user/API/MCP/app contexts. Root admission resolves the current governed-primary repository binding, exact immutable retention version, and a fresh snapshot, with `parent_run_id = null`. Child admission requires the parent's binding/retention and uses `createChildRunAuthorizationSnapshot` to narrow its ceiling.
- [ ] Re-fetch the immutable binding's exact provider snapshot and current deny generation; construct strict `RunSpecV2` with `run_kind = "repo_edit"` entirely server-side; persist and enqueue transactionally. The root/child cannot select a different repository, retention policy, engine, or authority from input.
- [ ] Explicitly exclude `put_repo_file`, `create_branch`, `open_pr`, and equivalent provider-mutation capabilities from the child tool allowlist even if the parent ceiling contains them. Publication is a host-owned post-verification port.
- [ ] Set optional `parent_run_id` plus trusted `run_kind = "repo_edit"`; return immediately after durable admission. Do not call `executePipelineTurn`, create a sandbox, call GitHub, or poll run status in the handler.
- [ ] Delete `POST /repos/agent/edit`, its contract import/tests, the MCP registration/tool, `editRepoFile`, `editRepoFileAction`, `EditFileLauncherDrawer`, the “Edit file & open PR” button, and their direct-action tests. Keep repository browsing and pull-request display.
- [ ] Remove the `agent` surface from `put_repo_file`, `create_branch`, and `open_pr`; update their MCP descriptions so they never direct an agent to the now-unavailable `agent.repo.edit` transport. The durable host publisher is the only agent-originated GitHub write path.
- [ ] Change chat rendering from immediate `prNumber/prUrl/diffs` output to the generic async-run activity path. Remove the app UI map entry and update capability/index/workbench docs to describe root-or-child agent-only async admission.
- [ ] Test flag-off denial, real root context creation, direct-human rejection, `parent_run_id = null`, exact child-binding inheritance, repository mismatch, suspended agent, changed deny generation, enqueue idempotency under kernel request ID, and a child that cannot invoke low-level VCS mutations even when its parent can.
- [ ] Remove the immediate diff/PR capability-card mapping. Retain a generic activity label that links to the durable run page/status consumer.
- [ ] Run `pnpm --filter @oxagen/handlers test:unit -- agent.repo.edit.test.ts`; expect pass.
- [ ] Run `pnpm --filter @oxagen/oxagen test:unit -- agent.repo.edit capability-meta.test.ts`; expect pass.
- [ ] Run `pnpm --filter @oxagen/config test:unit -- src/env.test.ts src/registry.test.ts`; expect pass.
- [ ] Run `pnpm env:check`; expect pass.
- [ ] Run `pnpm check:manifest`; expect pass.
- [ ] Run `pnpm schema:manifest && pnpm schema:manifest:check`; expect pass.
- [ ] Run `pnpm --filter @oxagen/app test:unit -- repos.test.ts actions.test.ts repo-drawers.test.tsx repos-client.test.tsx composer-pr-status-chip.test.tsx`; expect pass.
- [ ] Run `pnpm --filter @oxagen/api test:unit -- chat.stream.test.ts routes.agent-extended.test.ts`; expect pass.
- [ ] Run `pnpm --filter @oxagen/app exec playwright test e2e/workbench-repos.spec.ts`; expect the repository browser to remain and the direct edit launcher to be absent.
- [ ] Run `pnpm check:ui-parity`; expect pass.
- [ ] Run `rg -n 'repos/agent/edit|EditFileLauncherDrawer|editRepoFileAction|GitHubWorkspace|input\.baseBranch|\?\? "main"' apps packages/handlers/src/agent.repo.edit.ts`; inspect every match and expect no governed-path bypass.
- [ ] Commit: `refactor(agent): cut over governed repository edit admission`

## Task 4: Execute Code Mode in the Durable Worker

**Files:**

- Create: `packages/agent/src/runtime/repo-edit-driver.ts`
- Create: `packages/agent/src/runtime/repo-edit-driver.test.ts`
- Create: `packages/agent/src/runtime/repo-publisher.ts`
- Create: `packages/agent/src/runtime/repo-publisher.test.ts`
- Create: `packages/agent/src/runtime/change-classifier.ts`
- Create: `packages/agent/src/runtime/change-classifier.test.ts`
- Create: `packages/github/src/governed-repository.ts`
- Create: `packages/github/src/governed-repository.test.ts`
- Modify: `packages/agent/src/runtime/turn-driver.ts`
- Modify: `packages/agent/src/runtime/turn-driver.test.ts`
- Modify: `packages/agent/src/adapters/sandbox-workspace.ts`
- Modify: `packages/agent/src/adapters/sandbox-workspace.test.ts`
- Modify: `packages/agent/src/index.ts`
- Modify: `packages/agent-worker/src/main.ts`
- Modify: `packages/github/src/types.ts`
- Modify: `packages/github/src/fetch-client.ts`

- [ ] Write the driver and sandbox tests first with a claimed `repo_edit` `RunSpecV2`. They must fail on today's deletion-dropping `getChangedFiles()` and missing tree/PR receipts. Green asserts no context/model work until the exact provider repository ID, base commit, and base tree are verified.
- [ ] Create one sandbox session per attempt and check out the immutable commit detached. Immediately scrub global credential helpers and `.git-credentials`, verify `HEAD` and `HEAD^{tree}`, verify the remote by provider repository ID through the exact connection, and record checkout/environment receipts.
- [ ] Add NUL-safe `getChangeSet()` to `ModalSandboxWorkspace`. Capture create/modify/delete/rename, old/new mode, exact before/after bytes/digests, dirty/untracked digests, and PR 2 `rpl_` opaque path locators. Unsupported symlink/submodule/mode transitions fail typed rather than being corrupted.
- [ ] Send exact content/patch bytes directly to PR 2's encrypted evidence blob sink under pinned retention. They never enter the handler output, run summary, ClickHouse, or Neo4j.
- [ ] Run the existing TypeScript judged code pipeline through the PR 2 receipt-wrapped context/model/tool/command/approval ports. Every tool still re-enters `kernel.invoke()` with the attempt IAM context.
- [ ] Record clean-state digests at start, before/after digests for each mutation, dirty/untracked terminal digests, deterministic verification receipts, and an explicit verification outcome even when unavailable or not run.
- [ ] Run an Oxagen-owned coarse change classifier before finalization using only the governed repository binding, approved `CodeScope`/`Domain` registry, and local change metadata. Each result records `authority`, method/version, input digest, confidence, and scope/domain public ID; no match is explicit `unresolved`. PR 4 consumes this receipt and never infers scope later from a path or branch name.
- [ ] Implement `publishChangeSet` in `packages/github/src/governed-repository.ts`: create blobs, create one tree with `base_tree` (null tree entries for deletes; delete+add for renames), create one commit, create/update the deterministic ref, open one PR, then re-fetch ref/commit/tree/PR. Return branch, parent, commit, tree, and provider PR identifiers/SHAs as receipts.
- [ ] Make publication retry-safe. Reuse an existing deterministic ref/PR only when parent, tree, head, and base match the intended change set; any mismatch is an integrity error. If PR creation fails after branch/commit, retain partial provider receipts and finalize with an explicit publish gap.
- [ ] Immediately before the first provider mutation, refresh live initiating-human/agent/parent status, deny generations, and publication capability against the pinned ceiling; persist the decision. A denial/failure performs no further provider write and finalizes with any already-observed partial receipts plus an explicit publish gap.
- [ ] Generate the target branch under a server-owned collision-resistant namespace derived from the run public ID. The model and caller cannot provide it.
- [ ] Publish only after the configured verification/approval policy passes. If no changes exist, finalize with `provider_publish = not_applicable`; do not open an empty PR.
- [ ] On sandbox, model, tool, verification, or publication failure, emit terminal coverage and let the durable finalization obligation produce the manifest. Never jump to `GitHubWorkspace`.
- [ ] Leave PR 2's Neo4j/ClickHouse/provider delivery rows pending while PR 4 flags are disabled. Completing PR 3 does not imply projection has run.
- [ ] Dispose or preserve the sandbox according to the pinned retention/restoration policy and record the outcome; cleanup failure cannot erase the evidence obligation.
- [ ] Run `pnpm --filter @oxagen/agent test:unit -- repo-edit-driver.test.ts`; expect pass.
- [ ] Run `pnpm --filter @oxagen/agent test:unit -- repo-publisher.test.ts`; expect pass.
- [ ] Run `pnpm --filter @oxagen/agent test:unit -- change-classifier.test.ts`; expect pass, including `unresolved` and no-path-leak cases.
- [ ] Run `pnpm --filter @oxagen/agent test:unit -- sandbox-workspace.test.ts`; expect pass.
- [ ] Run `pnpm --filter @oxagen/github test:unit -- governed-repository.test.ts`; expect pass.
- [ ] Run `pnpm --filter @oxagen/agent test:unit -- turn-driver.test.ts`; expect pass.
- [ ] Commit: `feat(agent): run governed repository edits durably`

## PR 3 Exit Criteria

- [ ] The only launch invocation path is an agent-context `kernel.invoke("edit_repo_file")` that returns a durable root-or-child run handle.
- [ ] The PR merges with `RUN_EVIDENCE_REPO_EDIT_ENABLED=false`; enabling waits for PR 4 consumers and an explicit rollout decision.
- [ ] No caller can choose owner, repository, connection, ref, branch, model, environment, identity, retention, or replay authority.
- [ ] The model receives no context until the sandbox verifies the provider repository ID and immutable base commit/tree.
- [ ] GitHub-API-only execution, PAT fallback, direct API/MCP/app invocation, default-`main`, low-level agent VCS mutation, and legacy `record_execution` are absent.
- [ ] Completed, denied, failed, cancelled, verification-failed, and abandoned repo-edit attempts all reach the PR 2 finalization outbox.

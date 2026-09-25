# CLAUDE.md

@AGENTS.md

Read both files before changing the repository. `AGENTS.md` owns the repository map, capability conventions, storage boundaries, review rules, and standing decisions. This file adds operating instructions shared by all four harnesses.

## Product and architecture

Read `docs/VISION.md` for feature direction and `apps/app/ARCHITECTURE.md` for app invariants. Oxagen governs agents through a mandate and records governed activity. It does not run the agent workload (ADR-043). The product is workforce management for autonomous agents and the category is the agent control plane (ADR-113, superseding the product name in ADR-067). Do not write "Mission Control" in current prose or product copy. The record's operator-facing surface is the operator review: one page per person, read from the record, with spend by operator, agent and workspace, outcome per dollar for bounded tasks, prompt habits from the recorded turns, and one recommendation per habit worded as a rule the operator can adopt. It reports what the record shows and never grades the person. Check `DEREGISTERED.md` before removing a feature's files. An unreachable feature may have deliberately preserved code.

Use the code to establish what ships. Specs record intent, ADRs record decisions, and old plans record the implementation sequence at their date. A plan's unchecked box or old audit count is not evidence that the current implementation is missing.

## Operating mode

- Start from fresh remote refs. Create a branch from current `origin/main`, use an isolated worktree for large changes, and push the branch immediately. Never commit or push directly to `main`.
- Commit and push at meaningful increments. Open a PR against `main` and keep its description aligned with the final change. Follow `CONTRIBUTING.md`.
- Fix defects encountered within the task. Investigate the cause, fix related instances, and provide verification. Follow SCR-004 when a fix cannot responsibly ride the PR.
- Delegate independent work with explicit file ownership. Keep dependent edits sequential. Use agents that can edit when the task needs edits, and verify their changes before committing.
- Match an available model to the task. Do not require model names or tool APIs that the active harness does not provide.
- Do not rewrite shared history for cosmetic cleanup. Before merging, check for overlapping changes on `main` as described in AGENTS.md and ADR-110.

## Pull request monitoring

Every PR you open gets a watcher from the first push until it merges or closes. Start it right after `gh pr create`. In Claude Code, run it as a background agent or a Monitor loop. In another harness, run it as a loop in the session.

- **Poll every 60 seconds.** Each poll reads `gh pr view <n> --json state,headRefOid,mergeable,mergeStateStatus,statusCheckRollup`. Judge only the runs for the current head commit. A run cancelled because you pushed again is not a failure.
- **Read each job as it finishes, not the whole run.** A job that fails is a signal the moment it fails, while the rest of the run is still going. Read its failing step with `gh run view --job <job-id> --log-failed`, fix the cause on the branch, and push. Do not wait for the workflow to finish before you start the fix.
- **Resolve conflicts as soon as they appear.** When `mergeable` reads `CONFLICTING`, merge current `origin/main` into the branch, resolve each conflict, check the behavior both sides changed (ADR-110), and push. A conflicting PR gets no CI run at all, so `gh pr checks` can read green while nothing ran.
- **A schema change needs only its label.** If the diff changes a schema, confirm `migration-required` is on the PR, and add it if `migration-label.yml` has not. `migration-gate` applies the migration on merge (SCR-006).
- **Report checks as they are.** Pending is pending. A cancelled or skipped required job is not a pass. Name the job and its state.
- **Answer review findings** under the severity and round rules in `AGENTS.md` under Git Workflow.

Stop the watcher when the PR merges or closes, and say which in your report.

## Verification policy

CI is the build, lint, typecheck, coverage, and full test gate. Do not run those suites on this shared machine. The local test exception is one test file for code this task changed or created, run in isolation. Never run a package-wide suite. Restate this restriction when delegating work.

```bash
pnpm --filter @oxagen/<package> test:unit path/to/changed.test.ts
```

Do not insert `--` before the test filename. That form can discard the filter and run the whole package.

Lightweight file, link, contract, and prose integrity checks remain part of review. Run `pnpm check:prose` for published prose changes. Git hooks run their configured staged-file and integrity checks. Do not start or kill the shared dev stack to satisfy a merge checklist.

- Add tests for changed behavior. Keep coverage thresholds at or above their current values, capped at 90, with 2.5 percentage points of headroom.
- `apps/app/e2e/` contains exactly `login`, `pay`, and `page-load`. Prove other flows with component and action tests. See `apps/app/ARCHITECTURE.md` §6.3.
- For code changes, ask the test-engineer agent to audit coverage before the finished commit. Documentation-only changes need source and link verification, not new behavior tests.
- Save local verification artifacts under the gitignored `verifications/<session-id>/`. State what ran and what remains unverified.
- For UI changes, capture a working page or run the relevant component test. For a deployment or database mutation, verify the resulting state with a health check, API response, or query.
- Watch every PR you open until it merges or closes, as set out in Pull request monitoring below. Do not report pending or failed checks as passed.

## Database and dependency changes

- Add dependencies to the package that imports them. Update the lockfile with `pnpm i --no-frozen-lockfile` when dependencies change.
- Put Postgres migrations in `packages/database/atlas/migrations/`. Generate them with Atlas and choose a timestamp later than the existing migration baseline. `db:lint-migrations` checks that baseline in CI.
- From `packages/database`, regenerate the checksum with `atlas migrate hash --dir "file://atlas/migrations"`. Do not hand-edit `atlas.sum`.
- Confirm the database host and database name before mutation. Do not print credentials. A shell-exported `DATABASE_URL` overrides `tsx --env-file=.env.local`; unset it when the env file should choose the target.
- CI applies production migrations. On every push to `main`, `migration-gate` in `pipeline.yml` applies pending Postgres migrations with `infra/tools/apply-postgres-migrations.sh` and pending ClickHouse and Neo4j migrations with `tools/scripts/db-migrate.ts`, then re-checks all three stores. Mac decided this on 2026-09-23 (#3653). The gate refuses an unreadable store and a Postgres revision table that lists every migration as pending. For those cases, apply by hand: `infra/tools/run-db-migrations.sh packages/database --apply` from a laptop with AWS credentials on a checkout of `origin/main`, the `db-migrate.yml` dispatch with target production, or the `store-migrate.yml` dispatch. See README.md Deployment.
- Label a schema-changing PR `migration-required` (SCR-006). `.github/workflows/migration-label.yml` reads the diff and applies it, and re-applies it if it is removed while the diff still changes a schema. The label is the only thing a schema change adds to a PR. Do not write apply steps in the PR or apply anything by hand. `migration-gate` applies the migration when the PR merges.
- The migration reaches production before or with the deploy of the code that assumes it, never after. `migration-gate` blocks `deploy-node` until every store reads current after its apply. An unreadable store blocks too, so a failed SSM tunnel stops a deploy that has no missing migration. Re-run the job before reaching for a manual apply.
- Stamp a new Postgres migration later than every migration on `main`. The gate does not pass `--exec-order non-linear`, so a migration stamped before one production already carries makes the apply fail and blocks the deploy until the branch renumbers it.

The four incidents behind those rules are #1275, #2796, #3449 and #3692: the same schema change merging green, deploying, and never reaching a database. The fifth cost was the manual apply itself: on 2026-09-23 main sat undeployed behind #3735's migration while open branches piled up, which is why CI now applies.

## Four first-class harnesses: Claude Code, Codex, Cursor, Stella

Oxagen wraps four agent harnesses as equals (ADR-101): **Claude Code, Codex, Cursor and Stella.** Claude Desktop is a fifth, connected rather than wrapped (ADR-078). No harness is the default in a design, a list, a help string, or a test.

- **Everything Oxagen exports must load in all four.** For agents, skills, steering, rules, memories, commands, MCP entries, and hooks, a harness-facing feature is not done until each of the four can load it, or its PR names the harness that cannot and why. Check the table in ADR-101 for where each harness reads each artifact before you write a file for one.
- **Claude Code's layout is canonical. Bridges point to that source.** Author skills in `.claude/skills/`, subagents in `.claude/agents/`, commands in `.claude/commands/`, and rules in `AGENTS.md` and this file. The bridges already in the tree:
  - `.agents/skills` is a symlink to `.claude/skills`, so Codex sees the skills.
  - `.cursor/rules/oxagen.mdc` always applies and pulls in `AGENTS.md` and this file, so Cursor reads the rules.
  - `.cursor/commands` is a symlink to `.claude/commands`.
  - Cursor reads `.claude/skills` and `.claude/agents` natively. Stella adopts `.claude/{skills,agents,commands}` on `stella init` and reads both `AGENTS.md` and this file.
- **A rule every agent must follow goes in `AGENTS.md` or this file**, never only in a harness-specific path. Codex reads `AGENTS.md` alone, and `AGENTS.md` tells it to read this file too.
- **Adding a harness-facing enum member requires a cross-surface audit.** `WRAPPED_HARNESSES` (`packages/tacho/src/wire.ts`), `TACHO_RUNTIMES` (envelope and database, with an Atlas migration for the `tacho_sessions_runtime_check` constraint), the agent-registry harness enums (`agent.list.ts`, `v2/register-agent.ts`, `v2/get-agent.ts`, and the `agents_harness_check` constraint). `apps/desktop` is in this repository, so its `Harness` union is part of the same set. A list that names Codex and not Cursor is a defect.
- **How Cursor is wrapped.** `tacho enroll --harness cursor` writes `~/.cursor/hooks.json`, which the IDE and `cursor-agent` both read. `tacho-hook --harness cursor` runs Cursor's payload and answer through `packages/tacho/src/claude-code/cursor-adapter.ts`, the way Stella's go through `stella-adapter.ts`. Cursor has no `ask` on `preToolUse`, so a policy that asks is answered deny with the reason. Cursor's model calls do not pass through the Oxagen gateway, so its spend is not metered.

## App source map

`apps/app` has its own components at `src/ui/`, feature lanes at `src/features/`, and data ports at `src/data/`. Import UI through `@/ui/<name>`. `apps/docs` and `apps/app_deprecated` use `@/components/ui/<name>`. See AGENTS.md for the import rule and its enforcement limits.

Use these files to inspect the current app:

| Concern | Source |
|---|---|
| Routes | `apps/app/src/app/` and `apps/app/e2e/routes.ts` |
| Architecture and enforced invariants | `apps/app/ARCHITECTURE.md` and `apps/app/src/test/arch/` |
| Shell and assistant flyout | `apps/app/src/features/shell/` |
| Server data adapters | `apps/app/src/data/live/` |
| Capability to UI bindings | `apps/app/capability-ui-map.json` |
| Translations | `apps/app/messages/` |
| Package versions | Each app's `package.json` and `pnpm-workspace.yaml` overrides |

The workspace root is Fleet. Workspace routes include Runs, Mandates, Agents, Tools, Steering, Spend, Skills, and registration. Organization routes include Organization, Billing, Audit, Roles, API keys, and Model funding. Read the route source before adding a link. The former `[orgSlug]/[workspaceSlug]` routes and `src/components/` belong to `apps/app_deprecated`.

The current assistant flyout and the retained API chat transport are separate surfaces. Do not copy the deprecated app's `use-tool-stream.ts` path into new app guidance. Use existing data ports and server actions, and keep platform actions behind capability contracts.

## Runtime checks that matter

- Register handlers before calling `invoke()`. A missing handler throws `CapabilityError` with code `no_handler`. Handler registration does not install IAM, billing, or entitlement gates. Bootstrap those at the surface entry point.
- `apps/app/instrumentation.ts` boots the gates. `packages/iam/src/check-iam.ts` fast-paths non-enterprise human principals, so a handler that must enforce an organization role still calls `assertOrgRole`, or `assertContractRole`, which reads the contract's own `defaultRoles`. stella's tool belt leaves off a capability the person's roles do not grant, but the handler check is the enforcement.
- Route LLM calls through `@oxagen/ai` and resolve models with `modelIdOf()`. Do not import generation functions directly from `ai`, use `ai/rsc`, or hard-code provider slugs.
- Resolve organization stores through `resolveDataPlane()` in `@oxagen/tenancy` (ADR-042). Platform tables and `withSystemDb` stay on the shared plane. Read `DATABASE_URL`, `NEO4J_URI`, and `CLICKHOUSE_URL` only inside their store clients.
- Use `withTenantDb` or `withSystemDb` for Postgres. Raw `db()` is banned. Confirm scope and principal at the data boundary.
- Better Auth's pluralized adapter expects `rateLimits`. Test auth changes against production-equivalent rate limiting.
- Workflow environment variables used by Turbo tasks must also appear in the task's `env[]` in `turbo.json`.
- Regenerate `apps/app/src/i18n/messages.d.ts` with `pnpm --filter @oxagen/app gen:messages` after catalogue changes. Commit the generated file.
- Show graph records by their human label. Resolve authorized endpoint labels server-side and make raw identifiers copyable in details, not the primary display label.

## Issue titles

After triage, an issue title says its priority, where it bites, and what is wrong, in
that order, so a backlog reads without opening anything:

```
P<n> · <area>/<surface> · <what is wrong or missing>
```

Before triage, use `Queued · <area>/<surface> · <what is wrong or missing>` and apply
only `triage`. The area and surface in the title are provisional. The triage identity
replaces `Queued` with the assigned priority and aligns the area with its label.

- **`P<n>`** repeats the issue's `P0`-`P4` label. The label is the source of truth; the
  prefix is what a list, a search result, and a notification show. Retitle when the triage
  identity assigns or changes the priority.
- **`<area>`** is the `area:` label without its prefix: `app`, `surfaces`, `kernel`,
  `auth`, `billing`, `knowledge`, `evidence`, `data`, `platform`, `ops`.
- **`<surface>`** is where a person meets the defect: an app page (`Fleet`, `Run`,
  `Mandates`, `Agents`, `Tools`, `Steering`, `Spend`, `Skills`, `Organization`,
  `Repositories`, `Shell`), a wrapped surface (`API`, `MCP`, `CLI`, `Desktop`,
  `Gateway`, `Tacho`), a store (`Postgres`, `ClickHouse`, `Neo4j`), or an operational
  surface (`CI`, `Deploy`, `Migrations`, `Docs`). Join two with `+` when the change
  lands on both. Omit the segment entirely when the area is the surface.
- **The statement** is a sentence about the system, not a task name. "Approving a parked
  tool call never runs it" beats "Fix approvals". Follow `clear-prose`.
- **Residue issues** keep the same shape and carry their PR in a trailing
  `(residue #<PR>)`, which replaces the older `Residue from #<PR>:` prefix. List every
  PR when a residue issue carries more than one.

## Issues and labels

Track work in GitHub issues on `macanderson/oxagen`. Follow SCR-003, SCR-004, and SCR-005 in the standing decisions at the end of `AGENTS.md`.

**Assigned work carries an issue.** When you are asked to change functional code, tests, or documentation and no issue covers it, open one before the PR, apply only `triage`, and cite it in the PR body with `Closes #N` or `Refs #N`. A chore needs none: an edit to rules or agent instructions, a dependency or lockfile bump, formatting, or release bookkeeping. Mac set this on 2026-09-23. SCR-004 below covers a different case, a defect you notice along the way: fix it in the PR, and file it only when it cannot ride.

Fix defects in the task's PR when the fix can responsibly ride it. File an issue only when the work needs a maintainer decision, a rig, credentials, real spend, or more work than the session can carry. State that constraint and the maintainability, stability, reliability, innovation, efficiency, or performance benefit.

One issue carries one full change. Include context, paths, reproduction steps where relevant, a proposed approach, and a `- [ ]` definition of done. Do not create sub-issues, parents, or epics. Use the templates in `.github/ISSUE_TEMPLATE/`.

- A PR uses `Closes #N` only when it finishes every item in that issue's definition of done. Otherwise use `Refs #N`.
- A PR that closes no issue, such as a chore, uses `no-issue` for a trivial change or `closes-nothing` for a substantial change. These are PR labels, not substitute text in the body.
- A PR that changes a schema carries `migration-required` (SCR-006). `migration-label.yml` applies it from the diff. Add it yourself only if the workflow has not, and never remove it while the diff still changes a schema, because the workflow puts it back. Nothing else about the PR changes: `migration-gate` applies the migration on merge.
- Apply only `triage` to an issue you create. The triage identity applies priority, size, and descriptive labels. Never apply workflow-owned labels manually.
- CI files a `P0` issue labelled `deployment-failure` when `main` goes red or a production deploy fails, and closes it when a later run recovers (`.github/workflows/deployment-failure.yml`). This is the one priority label a workflow applies; `triage-guard.yml` exempts it. Record the root cause and fixing PR in a comment, and leave the open and close to CI, because the time between them is the recovery-time statistic.
- Close an issue as completed only with verification. Use not planned with an explanation for duplicates, superseded work, or a decision not to proceed.
- Follow the review severity and three-round residue rules in `AGENTS.md` under Git Workflow. That file owns the rule, including the fourth-round P1 exception and the P0 block.

Four issue fields carry what a label cannot. When these fields are available in GitHub,
set them when you open an issue and correct them when you learn better. Until they are
provisioned, add an `Issue metadata` section to the issue body with each field name and
its value. Keep those values current, then copy them into the fields when available:

| Field | Type | What it records |
|---|---|---|
| Estimated agent minutes | Number | Minutes of agent work to reach the definition of done, including tests, docs and review response. Not wall-clock, and not human hours. |
| Impacts schema | Yes / No | The change alters a Postgres, ClickHouse or Neo4j schema and needs a migration. |
| Breaking change | Yes / No | The change alters a capability contract, an API response, a CLI flag, a hook payload or a stored format that a consumer already depends on. |
| Customer reported | Yes / No | A customer or prospect reported the problem. An audit, a reviewer, CI or telemetry did not. |

Size labels stay: they size the change, while estimated agent minutes sizes the work.

The triage scheme uses one `kind:` and one `job:` per issue:

| Dimension | Values |
|---|---|
| Kind | `defect`, `gap`, `feature`, `debt` |
| Job | `govern`, `ground`, `explain`, `meter`, `rate` |
| Area | `app`, `surfaces`, `kernel`, `auth`, `billing`, `knowledge`, `evidence`, `data`, `platform`, `ops` |
| Pillar | `stability`, `reliability`, `maintainability`, `innovation`, `efficiency`, `performance` |
| Need | `decision`, `rig` |

A missing part of an existing spec or implementation is a gap. A feature introduces new behavior with a rationale against `docs/VISION.md`. A decision belongs in an ADR; use `needs:decision` only when it blocks a concrete fix. Read `gh label list` for current labels and descriptions.

`check:manifest:tickets` and `e2e:failure-ticket` still target Linear and no-op without `LINEAR_API_KEY`. Issue #2980 tracks their move to GitHub. `linear-release.yml` publishes release notes and is separate from issue tracking.

## Documentation maintenance

Keep active instructions close to their source. Use `docs/README.md` to navigate internal docs and `apps/docs/content/docs/` for published instructions. Update capability docs when contracts change, including their registered names, surfaces, and index entries.

Do not copy package counts, dependency versions, route lists, or old gap counts into additional documents. Link to the manifest, route oracle, check output, or owning source instead. Preserve useful decisions and incident records with their dates. Remove duplicate copies and repair their inbound links.

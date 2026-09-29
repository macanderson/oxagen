# CLAUDE.md

@AGENTS.md

Read both files before changing the repository. `AGENTS.md` owns the repository map, capability conventions, storage boundaries, review rules, and standing decisions. This file adds operating instructions shared by all four harnesses.

## Local execution

Mac set this on 2026-09-26 for every repository on this machine. Local builds, test runs, dev servers, and git hooks ran the laptop out of memory and killed agent runs partway through, and every killed run costs money. CI is the only place code is built, checked, or tested.

- Do not run the gate, a build, a typecheck, a lint, or any test, not even one test file. Push the branch and read the CI result. Read a failed job with `gh run view --job <id> --log-failed`.
- Do not start a dev server: no `next dev`, `next start`, `pnpm dev`, a server under `cargo run`, or anything else that listens on a port.
- Do not start Docker or Colima, and do not run anything that needs them.
- Do not run Biome in any form.
- Git hooks are off on this machine. `LEFTHOOK=0` and `HUSKY=0` are set for every shell and every Claude Code session. Do not reinstall a hook, turn one back on, or run a hook's commands by hand.
- Code generators and small integrity scripts that only read and write files are allowed, such as regenerating a checksum, a schema index, or a message catalogue.
- Put this rule, word for word, in the prompt of every subagent you start.

## Product and architecture

Read `docs/VISION.md` for feature direction and `apps/app/ARCHITECTURE.md` for app invariants. Oxagen governs agents through a mandate and records governed activity. It does not run the agent workload (ADR-043). The product is workforce management for autonomous agents and the category is the agent control plane (ADR-113, superseding the product name in ADR-067). Do not write "Mission Control" in current prose or product copy. The record's operator-facing surface is the operator review: one page per person, read from the record, with spend by operator, agent and workspace, outcome per dollar for bounded tasks, prompt habits from the recorded turns, and one recommendation per habit worded as a rule the operator can adopt. It reports what the record shows and never grades the person. Check `DEREGISTERED.md` before removing a feature's files. An unreachable feature may have deliberately preserved code.

Use the code to establish what ships. Specs record intent, ADRs record decisions, and old plans record the implementation sequence at their date. A plan's unchecked box or old audit count is not evidence that the current implementation is missing.

## Operating mode

- Start from fresh remote refs. Create a branch from current `origin/main`, use an isolated worktree for large changes, and push the branch immediately. Never commit or push directly to `main`, except to repair a red `main` under a P0 outage issue, which AGENTS.md under Git Workflow sets out.
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
- **Answer review findings** under the severity and round rules in `AGENTS.md` under Git Workflow. On a PR labelled `agent-monitored-pr`, the pass rule in Agent-monitored pull requests replaces the round rule.

Stop the watcher when the PR merges or closes, and say which in your report.

## Replies to PR feedback

Mac set this on 2026-09-28 for every repository and every PR, labelled or not. Each feedback comment an agent fixes gets two replies from that agent, with no exceptions.

- **Reply with the fix branch before the first edit.** Create the branch that will carry the fix, then reply to the feedback comment with the branch name. Post this reply before you change any file for that comment.
- **Reply with the commit SHA once the fix is done.** After the fix is committed and pushed, post a second reply to the same comment with the commit SHA.
- **Give every comment its own two replies.** One reply answers one feedback comment. When one branch or one commit fixes several comments, each comment still gets both replies.
- **Reply where the comment lives.** Answer a review thread inline, on the comment itself (`gh api repos/<owner>/<repo>/pulls/<n>/comments/<id>/replies`). A finding in a review body or a top-level comment has no thread, so answer it with two PR comments that each quote it.
- **Mark both replies.** A watcher starts each reply with `<!-- pr-watch -->`, as it does every comment it posts.

Agents chose these details on 2026-09-28, and Mac has not ruled on them. Cut the fix branch from the PR's head branch. One fix branch may carry several comments. Merge the fix branch into the PR's head branch before the second reply, so the SHA in that reply is a commit on the PR branch. A comment the agent does not fix, because it goes to a residue issue or does not hold, keeps one reply with the issue link or the evidence. A fix-branch reply with no commit-SHA reply after it marks unfinished work, and the next watcher picks it up.

## Agent-monitored pull requests

Mac set this on 2026-09-26 for every repository. The `agent-monitored-pr` label marks a PR that an agent watches until it merges or closes. A labelled PR comes before other work, and its fixes run in parallel wherever that is safe.

- **Label every PR an agent opens.** Pass `--label agent-monitored-pr` to `gh pr create`. If the repository has no such label, create it first: `gh label create agent-monitored-pr --color fd0880 --description "Agent polls every 60 seconds fixes CI, comments, conflicts."`
- **Poll the PR every 60 seconds.** Each poll reads the PR's state, its mergeability, and the checks on the head commit. It reads every review thread that still needs a reply: one with no inline reply after the reviewer's last comment, or one whose fix-branch reply has no commit-SHA reply after it. `gh pr view --json` does not return review threads, so read them with `gh api graphql` (`pullRequest.reviewThreads`). It also reads review bodies and top-level comments, because a finding there has no thread. Answer each finding there as Replies to PR feedback sets out, with PR comments that quote it, and record the id of the comment you answered. Start every comment a watcher posts with `<!-- pr-watch -->`. Skip comments that start with that marker or with `<!-- pr-claim -->`, so a watcher does not answer its own comments.
- **Fix by review pass.** Pass N is the Nth review one reviewer submits on the PR. On pass 1, fix every P0, P1, and P2 finding. On pass 2, fix P0 and P1. From pass 3 on, fix P0 only. A P0 blocks the PR at every pass.
- **File one residue issue.** Carry every P1 and P2 finding left unfixed into a single issue for the PR. Its title ends with `(residue #<PR>)`, and its body links the PR. Reply inline on every thread you handle. A finding you fix gets the two replies in Replies to PR feedback. A finding you carry gets a reply that links the residue issue.
- **Let the pass rule govern review findings.** On a labelled PR, the pass rule decides which review findings get fixed, in place of any repository rule on review rounds or on fixing every finding in the PR. Residue goes to one issue, even where a repository files each finding alone. Where a repository allows one change per issue, residue from unrelated changes splits into one issue per change. A defect you notice yourself still follows fix over file. A P3 finding follows the repository's usual rules.
- **Clear conflicts and CI failures as they appear.** When the PR conflicts, merge the base branch in, resolve it, and push. When a job fails, read its failing step with `gh run view --job <id> --log-failed`, fix it, and push without waiting for the rest of the run.
- **Dispatch subagents.** Give each independent fix its own subagent when no two fixes touch the same file. Stay active until the PR merges or closes.
- **Search for the label every 60 seconds.** A session that watches PRs runs `gh search prs --owner macanderson --label agent-monitored-pr --state open --limit 1000` every 60 seconds. Without `--limit`, gh returns 30 results, and GitHub search returns at most 1000. The session takes each labelled PR that no live claim holds.
- **Claim a PR before the first write.** A PR has one writer. Two writers on one branch restart each other's CI and reject each other's pushes. To claim, post a PR comment whose first line is `<!-- pr-claim --> <login> <session-word> <runtime> <session name>`, then read the PR's comments again. The session word is one word that names your session, such as a job id. A claim holds for 90 minutes after it is posted. The oldest claim that still holds owns the PR. If that claim is not yours, delete your comment and message the owner instead of pushing. Before your claim lapses, post a new one and delete the old one. Delete your claim when you stop watching the PR. Agents chose this claim on 2026-09-26 to answer review findings, in the format of stella's `scripts/pr-claim.sh`, and Mac has not ruled on it.

## Verification policy

CI is the build, lint, typecheck, coverage, and full test gate. None of it runs on this shared machine, not even one test file for code this task changed. Push the branch and read the CI result. Restate this restriction when delegating work.

Lightweight file, link, contract, and prose integrity checks remain part of review. Run `pnpm check:prose` for published prose changes. Git hooks are configured for other machines and are off on this one. The shared dev stack is not started or stopped on this machine. CI starts the databases its jobs need.

- Add tests for changed behavior. Keep coverage thresholds at or above their current values, capped at 90, with 2.5 percentage points of headroom.
- `apps/app/e2e/` contains exactly `login`, `pay`, and `page-load`. Prove other flows with component and action tests. See `apps/app/ARCHITECTURE.md` §6.3.
- For code changes, ask the test-engineer agent to audit coverage before the finished commit. Documentation-only changes need source and link verification, not new behavior tests.
- Save local verification artifacts under the gitignored `verifications/<session-id>/`. State what ran and what remains unverified.
- For UI changes, cite the relevant component test from the CI run. A page capture needs a dev server, and no dev server runs on this machine. For a deployment or database mutation, verify the resulting state with a health check, API response, or query.
- Watch every PR you open until it merges or closes, as set out in Pull request monitoring below. Do not report pending or failed checks as passed.

## Database and dependency changes

- Add dependencies to the package that imports them. Update the lockfile with `pnpm i --no-frozen-lockfile` when dependencies change.
- Put Postgres migrations in `packages/database/atlas/migrations/`. Generate them with Atlas and choose a timestamp later than the existing migration baseline. `db:lint-migrations` checks that baseline in CI.
- From `packages/database`, regenerate the checksum with `atlas migrate hash --dir "file://atlas/migrations"`. Do not hand-edit `atlas.sum`.
- Confirm the database host and database name before mutation. Do not print credentials. A shell-exported `DATABASE_URL` overrides `tsx --env-file=.env.local`; unset it when the env file should choose the target.
- CI applies production migrations. On every push to `main`, `migration-gate` in `pipeline.yml` applies pending Postgres migrations with `infra/tools/apply-postgres-migrations.sh` and pending ClickHouse and Neo4j migrations with `tools/scripts/db-migrate.ts`, then re-checks all three stores. A Postgres apply runs `run-db-migrations.sh --apply`, which also runs `seedPlatform()`, so the Free plan and the book editions reach production with the migrations (ADR-123). Mac decided this on 2026-09-23 (#3653). The gate refuses an unreadable store and a Postgres revision table that lists every migration as pending. For those cases, apply by hand: `infra/tools/run-db-migrations.sh packages/database --apply` from a laptop with AWS credentials on a checkout of `origin/main`, the `db-migrate.yml` dispatch with target production, or the `store-migrate.yml` dispatch. See README.md Deployment.
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

Before you start a UI slice, read ADR-226, then the v3 mockup at the commit it pins, then the kit's tokens. The rev1 mockup (`mc.html`, `missioncontrol.html`, `engine.css`) is gone, and a page row or log entry that cites it is history.

Use these files to inspect the current app:

| Concern | Source |
|---|---|
| Routes | `apps/app/src/app/` and `apps/app/e2e/routes.ts` |
| Architecture and enforced invariants | `apps/app/ARCHITECTURE.md` and `apps/app/src/test/arch/` |
| Design of record | `docs/adr/ADR-226-the-v3-mockup-and-the-brand-kit-are-the-design-of-record.md`: the v3 mockup at its pin for layout and behavior, and the brand kit (`packages/ui/src/styles/house-tokens.css`) for tokens, type, and marks |
| Shell and assistant flyout | `apps/app/src/features/shell/` |
| Server data adapters | `apps/app/src/data/live/` |
| Capability to UI bindings | `apps/app/capability-ui-map.json` |
| Translations | `apps/app/messages/` |
| Package versions | Each app's `package.json` and `pnpm-workspace.yaml` overrides |

The workspace root is Fleet. Workspace routes include Runs, Mandates, Agents, Tools, Steering, Spend, Skills, and registration. Organization routes include Organization, Billing, Audit, Roles, API keys, and Model funding. Read the route source before adding a link. The former `[orgSlug]/[workspaceSlug]` routes and `src/components/` belong to `apps/app_deprecated`.

The current assistant flyout and the retained API chat transport are separate surfaces. Do not copy the deprecated app's `use-tool-stream.ts` path into new app guidance. Use existing data ports and server actions, and keep platform actions behind capability contracts.

## Labels and headings

Mac set this rule on 2026-09-21 and restated it on 2026-09-29, after the steering page shipped "Everything written down" and a "Who receives it" button. It applies to every UI string, doc, and mockup in this repository.

- **A heading names the thing.** Write a plain noun or noun phrase: "All items", "Origin", "Governance mode". Do not write a question phrase ("Who receives it", "Where it came from", "What merge will do"), an "Everything ..." slogan, or wordplay.
- **A button says what it does.** Write a verb and its object, in the form its sibling buttons use: "Open the assignments", "Open the compiler".
- **A caption, tile note, badge, or hint states one fact.** It carries no comma, no mid-dot (·), and no "not" or "never" contrast. "count per kind", not "one shape, every kind".
- **Subtext under a heading is one sentence or nothing.** Cut slogans such as "One concern, one pull request." and "The harness owns the context window."
- **The mockup's wording does not override this rule.** ADR-226 makes the v3 mockup the design of record for layout and behavior. Many of its labels break this rule, so rename a mockup label when you port it, and keep the mockup's structure.

Load `clear-prose` before you write any of these strings.

## Type

Mac set this on 2026-09-29. The app uses Geist for every heading and every line of text. Space Grotesk sets the Oxagen and stella wordmarks and, on oxagen.sh, the first line of a hero. It sets nothing else.

- `packages/ui/src/styles/globals.css` points `--font-display` at Geist (`--ox-font`), so `h1` to `h3` and the `text-m-h*` and `text-a-h*` utilities draw in Geist. Space Grotesk reaches the page only through `--font-wordmark` and the `.ox-wordmark` class.
- Do not write `--ox-font-display`, `--font-wordmark`, or "Space Grotesk" in app source outside a comment. `apps/app/src/test/arch/design-record.test.ts` fails on each of them.
- The brand kit (`oxagenai/oxagen-brand`) still names Space Grotesk as its display face. The files it syncs into `packages/ui/src/styles/` stay byte-identical to the kit, so the override lives in `globals.css`, after the kit's import.

## Runtime checks that matter

- Register handlers before calling `invoke()`. A missing handler throws `CapabilityError` with code `no_handler`. Handler registration does not install IAM, billing, or entitlement gates. Bootstrap those at the surface entry point.
- `apps/app/instrumentation.ts` boots the gates. `packages/iam/src/check-iam.ts` fast-paths non-enterprise human principals, so a handler that must enforce an organization role still calls `assertOrgRole`, or `assertContractRole`, which reads the contract's own `defaultRoles`. stella's tool belt leaves off a capability the person's roles do not grant, but the handler check is the enforcement.
- Route LLM calls through `@oxagen/ai` and resolve models with `modelIdOf()`. Do not import generation functions directly from `ai`, use `ai/rsc`, or hard-code provider slugs. Tool-search embeddings are the one exception, and AGENTS.md under Key Patterns names it (ADR-217).
- Resolve organization stores through `resolveDataPlane()` in `@oxagen/tenancy` (ADR-042). Platform tables and `withSystemDb` stay on the shared plane. Read `DATABASE_URL`, `NEO4J_URI`, and `CLICKHOUSE_URL` only inside their store clients.
- Use `withTenantDb` or `withSystemDb` for Postgres. Raw `db()` is banned. Confirm scope and principal at the data boundary.
- Better Auth's pluralized adapter expects `rateLimits`. Test auth changes against production-equivalent rate limiting.
- Workflow environment variables used by Turbo tasks must also appear in the task's `env[]` in `turbo.json`.
- Regenerate `apps/app/src/i18n/messages.d.ts` with `pnpm --filter @oxagen/app gen:messages` after catalogue changes. Commit the generated file.
- Show graph records by their human label. Resolve authorized endpoint labels server-side and make raw identifiers copyable in details, not the primary display label.

## Issue titles

After triage, an issue title gives its priority, kind, size, and area, then the problem
in plain words, so a person can read the backlog without opening an issue:

```
P<n> <Kind> <Size> (<Area>): <statement>
P0 Bug XS (CI): Main stays red because the coverage step reads a stale lockfile
P1 Feature L (Steering): Bulk import memories from Markdown files
```

Before triage, use `Queued <Kind> (<Area>): <statement>` and apply only `triage`. The
kind and area in that title are the creator's guess. The triage pass (`/triage-issues`)
replaces `Queued` with the priority, adds the size, and corrects the kind and area.
Mac replaced the older `P<n> · <area>/<surface> · <statement>` shape on 2026-09-25.

- **Each prefix part copies a label.** The label is the source of truth. The title is
  what a list, a search result, and a notification show. `P<n>` is the `P0`-`P4` label.
  `<Kind>` is `Bug` (`kind:defect`), `Gap`, `Feature`, or `Debt`. `<Size>` is the
  `size/` label. `<Area>` is the title name of the one `area:` label. Retitle whenever
  one of those labels changes.
- **The statement** says what goes wrong for a bug, and what a person will be able to do
  for a gap or feature. Write it for a reader who has never opened the codebase: no
  function names, paths, or internal terms. Aim for 80 characters and never exceed 100.
  Follow `clear-prose`, and do not write "Mission Control" (ADR-113).
- **Residue issues** carry their PR in a trailing `(residue #<PR>)`. List every PR when a
  residue issue carries more than one.

`.claude/commands/triage-issues.md` holds the full rules: the area table, how to choose
each label, and the procedure. Run `/triage-issues` to work the `triage` queue.

## Issues and labels

Track work in GitHub issues on `macanderson/oxagen`. Follow SCR-003, SCR-004, and SCR-005 in the standing decisions at the end of `AGENTS.md`.

**Assigned work carries an issue.** When you are asked to change functional code, tests, or documentation and no issue covers it, open one before the PR, apply only `triage`, and cite it in the PR body with `Closes #N` or `Refs #N`. A chore needs none: an edit to rules or agent instructions, a dependency or lockfile bump, formatting, or release bookkeeping. Mac set this on 2026-09-23. SCR-004 below covers a different case, a defect you notice along the way: fix it in the PR, and file it only when it cannot ride.

Fix defects in the task's PR when the fix can responsibly ride it. File an issue only when the work needs a maintainer decision, a rig, credentials, real spend, or more work than the session can carry. State that constraint and the maintainability, stability, reliability, innovation, efficiency, or performance benefit.

One issue carries one full change. Include context, paths, reproduction steps where relevant, a proposed approach, and a `- [ ]` definition of done. Do not create sub-issues, parents, or epics. Use the templates in `.github/ISSUE_TEMPLATE/`.

- A PR uses `Closes #N` only when it finishes every item in that issue's definition of done. Otherwise use `Refs #N`.
- A PR that closes no issue, such as a chore, uses `no-issue` for a trivial change or `closes-nothing` for a substantial change. These are PR labels, not substitute text in the body.
- A PR that changes a schema carries `migration-required` (SCR-006). `migration-label.yml` applies it from the diff. Add it yourself only if the workflow has not, and never remove it while the diff still changes a schema, because the workflow puts it back. Nothing else about the PR changes: `migration-gate` applies the migration on merge.
- Apply only `triage` to an issue you create. The triage identity applies priority, size, and descriptive labels. Never apply workflow-owned labels manually.
- Add no attribution to an issue, an issue comment, or a PR: no "Generated with Claude Code" footer, no `claude.ai/code` session link, and no co-author line. Mac had them stripped from every issue on 2026-09-25.
- CI files a `P0` issue labelled `deployment-failure` when `main` goes red or a production deploy fails, and closes it when a later run recovers (`.github/workflows/deployment-failure.yml`). This is the one priority label a workflow applies; `triage-guard.yml` exempts it. Record the root cause and the fixing commit (it lands straight on `main`, per AGENTS.md under Git Workflow) in a comment, and leave the open and close to CI, because the time between them is the recovery-time statistic.
- Close an issue as completed only with verification. Use not planned with an explanation for duplicates, superseded work, or a decision not to proceed.
- Follow the review severity and three-round residue rules in `AGENTS.md` under Git Workflow. That file owns the rule, including the fourth-round P1 exception and the P0 block. On a PR labelled `agent-monitored-pr`, the pass rule replaces the round rule.

Three issue fields carry what a label cannot. When these fields are available in GitHub,
set them when you open an issue and correct them when you learn better. Until they are
provisioned, add an `Issue metadata` section to the issue body with each field name and
its value. Keep those values current, then copy them into the fields when available:

| Field | Type | What it records |
|---|---|---|
| Impacts schema | Yes / No | The change alters a Postgres, ClickHouse or Neo4j schema and needs a migration. |
| Breaking change | Yes / No | The change alters a capability contract, an API response, a CLI flag, a hook payload or a stored format that a consumer already depends on. |
| Customer reported | Yes / No | A customer or prospect reported the problem. An audit, a reviewer, CI or telemetry did not. |

Size labels stay: they size the change, while `agent_mins_est` on the `All issues` board sizes the work (see Issue fields and reflection below).

A triaged issue carries one priority, one `kind:`, one `size/`, one `area:`, and one `job:` label:

| Dimension | Values |
|---|---|
| Kind | `defect`, `gap`, `feature`, `debt` |
| Job | `govern`, `ground`, `explain`, `meter`, `rate` |
| Area | `fleet`, `runs`, `mandates`, `agents`, `tools`, `steering`, `skills`, `spend`, `billing`, `organization`, `auth`, `onboarding`, `repositories`, `stella`, `app-shell`, `tacho`, `desktop`, `gateway`, `api`, `mcp`, `cli`, `database`, `ci`, `deploy`, `docs`, `compliance` |
| Pillar | one or two of `stability`, `reliability`, `maintainability`, `innovation`, `efficiency`, `performance` |
| Need | `decision`, `rig`, when they apply |

The area names where a person meets the problem, not the package that holds the code. Add `security` when the issue involves credentials, secrets, tenant isolation, access control, or personal data.

A missing part of an existing spec or implementation is a gap. A feature introduces new behavior with a rationale against `docs/VISION.md`. A decision belongs in an ADR. Use `needs:decision` only when the body asks the maintainer a specific question and the work waits on the answer. Read `gh label list` for current labels and descriptions.

Retired on 2026-09-25, so do not apply them: `build-time:*`, `model:tier-*`, `schema-change` (PRs use `migration-required`), and the code-owner areas `area:app`, `area:data`, `area:evidence`, `area:kernel`, `area:knowledge`, `area:ops`, `area:platform`, and `area:surfaces`.

`check:manifest:tickets` and `e2e:failure-ticket` still target Linear and no-op without `LINEAR_API_KEY`. Issue #2980 tracks their move to GitHub. `linear-release.yml` publishes release notes and is separate from issue tracking.

## Documentation maintenance

Keep active instructions close to their source. Use `docs/README.md` to navigate internal docs and `apps/docs/content/docs/` for published instructions. Update capability docs when contracts change, including their registered names, surfaces, and index entries.

Do not copy package counts, dependency versions, route lists, or old gap counts into additional documents. Link to the manifest, route oracle, check output, or owning source instead. Preserve useful decisions and incident records with their dates. Remove duplicate copies and repair their inbound links.

## Issue fields and reflection

Mac set this on 2026-09-28 for every repository. Every issue in Mac's repositories belongs on the `All issues` project board in the `macanderson` account. The board carries six fields. Keep all six correct on every issue you work on.

| Field | Values | Meaning |
|---|---|---|
| Prompt | Text | The prompt that starts an agent on the work |
| Model Tier | Ultra, Pro, Standard, Lite | The model tier the work needs |
| Size | XS, S, M, L, XL | The size of the change |
| `agent_mins_est` | Number | Agent minutes the work should take |
| `agent_mins` | Number | Agent minutes the work took |
| Resolution | Shipped, Won't ship, Duplicate | How the issue closed |

- **Add the issue to the board when you file it.** Set Prompt, Model Tier, and `agent_mins_est` at the same time. Set Size too, unless a triage rule in this repository gives sizing to the triage agent.
- **Stamp your minutes when your run ends.** Add the minutes your run spent on the issue to `agent_mins`. Add to the value already there, because several runs can share one issue.
- **Write a reflection when your run ends.** Post it as a comment on the issue. Give your run's minutes, say what shipped, compare `agent_mins` with `agent_mins_est`, and say what the next agent should know. The reflections are the record of minutes. If two runs write `agent_mins` at once and one value is lost, rebuild the sum from the reflections.
- **Set Resolution when the issue closes.**
- **Fix any field you find wrong** on any issue you touch.
- **Use the reflection until the board exists.** If `gh project list` shows no `All issues` board, or your token lacks the `project` scope, write the six values in the reflection instead. Copy them to the board once it exists.

These commands find the board and set a field:

```sh
gh project list --owner macanderson                                  # the board titled "All issues"
gh project field-list <number> --owner macanderson --format json     # field and option ids
gh project item-add <number> --owner macanderson --url <issue-url> --format json --jq .id   # the item id
gh project item-edit --project-id <project-id> --id <item-id> --field-id <field-id> --number 42
```

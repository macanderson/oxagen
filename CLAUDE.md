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
- **A schema change needs only its label.** If the diff changes a schema, confirm `MIGRATION-REQUIRED` is on the PR, and add it if `migration-label.yml` has not. `migration-gate` applies the migration on merge (SCR-006).
- **Report checks as they are.** Pending is pending. A cancelled or skipped required job is not a pass. Name the job and its state.
- **Answer review findings** under the severity and round rules in `AGENTS.md` under Git Workflow. On a PR labelled `AGENT-MONITORED-PR`, the pass rule in Agent-monitored pull requests replaces the round rule.

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

Mac set this on 2026-09-26 for every repository. The `AGENT-MONITORED-PR` label marks a PR that an agent watches until it merges or closes. A labelled PR comes before other work, and its fixes run in parallel wherever that is safe.

- **Label every PR an agent opens.** Pass `--label AGENT-MONITORED-PR` to `gh pr create`. If the repository has no such label, create it first: `gh label create AGENT-MONITORED-PR --color FD0880 --description "An agent polls every 60 seconds and fixes CI, comments, and conflicts"`
- **Open every PR as a draft.** Mac set this on 2026-10-01. Open every pull request as a draft (`gh pr create --draft`), push until the change is complete, then mark it ready with `gh pr ready`. The heavy CI lanes run only on ready pull requests, so a draft gets fast feedback from `checks` and `atlas-validate` alone. Batch fixes and push once, because every push to a ready pull request runs the full gate. On a draft, `test` fails on purpose, and the ready run replaces it. A watcher reads that failure as expected and does not try to fix it (#5094).
- **Poll the PR every 60 seconds.** Each poll reads the PR's state, its mergeability, and the checks on the head commit. It reads every review thread that still needs a reply: one with no inline reply after the reviewer's last comment, or one whose fix-branch reply has no commit-SHA reply after it. `gh pr view --json` does not return review threads, so read them with `gh api graphql` (`pullRequest.reviewThreads`). It also reads review bodies and top-level comments, because a finding there has no thread. Answer each finding there as Replies to PR feedback sets out, with PR comments that quote it, and record the id of the comment you answered. Start every comment a watcher posts with `<!-- pr-watch -->`. Skip comments that start with that marker or with `<!-- pr-claim -->`, so a watcher does not answer its own comments.
- **Fix by review pass.** Pass N is the Nth review one reviewer submits on the PR. On pass 1, fix every P0, P1, and P2 finding. On pass 2, fix P0 and P1. From pass 3 on, fix P0 only. A P0 blocks the PR at every pass.
- **File one residue issue.** Carry every P1 and P2 finding left unfixed into a single issue for the PR. Its title ends with `(residue #<PR>)`, and its body links the PR. Reply inline on every thread you handle. A finding you fix gets the two replies in Replies to PR feedback. A finding you carry gets a reply that links the residue issue.
- **Let the pass rule govern review findings.** On a labelled PR, the pass rule decides which review findings get fixed, in place of any repository rule on review rounds or on fixing every finding in the PR. Residue goes to one issue, even where a repository files each finding alone. Where a repository allows one change per issue, residue from unrelated changes splits into one issue per change. A defect you notice yourself still follows fix over file. A P3 finding follows the repository's usual rules.
- **Clear conflicts and CI failures as they appear.** When the PR conflicts, merge the base branch in, resolve it, and push. When a job fails, read its failing step with `gh run view --job <id> --log-failed`, fix it, and push without waiting for the rest of the run.
- **Dispatch subagents.** Give each independent fix its own subagent when no two fixes touch the same file. Stay active until the PR merges or closes.
- **Search for the label every 60 seconds.** A session that watches PRs runs `gh search prs --owner macanderson --owner oxageninc --label AGENT-MONITORED-PR --state open --limit 1000` every 60 seconds. Mac's repositories can sit under either owner, and a search of one owner misses the other's PRs. Without `--limit`, gh returns 30 results, and GitHub search returns at most 1000. The session takes each labelled PR that no live claim holds.
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
- Label a schema-changing PR `MIGRATION-REQUIRED` (SCR-006). `.github/workflows/migration-label.yml` reads the diff and applies it, and re-applies it if it is removed while the diff still changes a schema. The label is the only thing a schema change adds to a PR. Do not write apply steps in the PR or apply anything by hand. `migration-gate` applies the migration when the PR merges.
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
- **How Cursor is wrapped.** `oxagen agent enroll --harness cursor` writes `~/.cursor/hooks.json`, which the IDE and `cursor-agent` both read. `oxagen hook --harness cursor` runs Cursor's payload and answer through `packages/tacho/src/claude-code/cursor-adapter.ts`, the way Stella's go through `stella-adapter.ts`. Cursor has no `ask` on `preToolUse`, so a policy that asks is answered deny with the reason. Cursor's model calls do not pass through the Oxagen gateway, so its spend is not metered.

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

The workspace root is Fleet. Workspace routes include Runs, Mandates, Agents, Steering, Spend, Skills, and registration. Agents carries the MCP servers (`mcp-servers`), Policies, Runtimes, and Off switches tabs as `?tab=` values, and `/tools` and `/runtimes` redirect there. One runtime opens in a drawer over the Runtimes tab (`&runtime=<id>`). Organization routes include Organization, Billing, Audit, Roles, API keys, and Model funding. Read the route source before adding a link. The former `[orgSlug]/[workspaceSlug]` routes and `src/components/` belong to `apps/app_deprecated`.

The current assistant flyout and the retained API chat transport are separate surfaces. Do not copy the deprecated app's `use-tool-stream.ts` path into new app guidance. Use existing data ports and server actions, and keep platform actions behind capability contracts.

## Labels and headings

Mac set this rule on 2026-09-21 and restated it on 2026-09-29, after the steering page shipped "Everything written down" and a "Who receives it" button. It applies to every UI string, doc, and mockup in this repository.

- **A heading names the thing.** Write a plain noun or noun phrase: "All items", "Origin", "Governance mode". Do not write a question phrase ("Who receives it", "Where it came from", "What merge will do"), an "Everything ..." slogan, or wordplay.
- **A button says what it does.** Write a verb and its object, in the form its sibling buttons use: "Open the assignments", "Open the compiler". Name the object, not a pronoun: "Remove provider", not "Remove it" or "Read them".
- **A caption, tile note, badge, or hint states one fact.** It carries no comma, no mid-dot (·), and no "not" or "never" contrast. "count per kind", not "one shape, every kind".
- **Subtext under a heading is one sentence or nothing.** Cut slogans such as "One concern, one pull request." and "The harness owns the context window."
- **The mockup's wording does not override this rule.** ADR-226 makes the v3 mockup the design of record for layout and behavior. Many of its labels break this rule, so rename a mockup label when you port it, and keep the mockup's structure.

Load `clear-prose` before you write any of these strings. `apps/app/src/test/arch/label-voice.test.ts` (INV-35) fails CI on the shapes it can read in `apps/app/messages/*.json`. It cannot read meaning, so read every catalogue diff for a slogan too.

## Type

Mac set this on 2026-09-29. The app uses Geist for every heading and every line of text. Space Grotesk sets the Oxagen and stella wordmarks and, on oxagen.sh, the first line of a hero. It sets nothing else.

- The kit's `packages/ui/src/styles/house-tailwind.css` sets `--font-display` and `--font-sans` to Geist, so every heading and the `text-m-h*` and `text-a-h*` utilities draw in Geist. Space Grotesk reaches the page only through `--font-wordmark`, the `.ox-wordmark` class, and the kit's `hero-line-1` class on a marketing hero.
- Do not write `--ox-font-display`, `--font-wordmark`, or "Space Grotesk" in app source outside a comment. `apps/app/src/test/arch/design-record.test.ts` fails on each of them.
- The brand kit (`oxageninc/brand`) has set every heading in Geist since 2.4.0 (#27), so `globals.css` carries no font override. The files the sync writes into `packages/ui/src/styles/` stay byte-identical to the kit.

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

Mac set this format on 2026-09-30 for oxagen and stella. An issue title gives its
priority, model tier, size, kind, and area, then the problem in plain words, so a person
can read the backlog without opening an issue:

```
<Priority> <Tier> <Size> <Kind> (<Area>): <Statement>
P0 T3 XS Bug (CI): Main stays red because the coverage step reads a stale lockfile
P1 T3 L Feature (Steering): Bulk import memories from Markdown files
```

The creator writes the full title when filing the issue. Mac set this on 2026-10-02: a
new issue carries no `TRIAGE` label and no `Queued <Kind> (<Area>): <Statement>` title.
An older issue may still carry both, and a workflow may file an issue with no priority.
`/triage-issues` finds each of these by its missing priority label and completes it. The
2026-09-30 format replaced `P<n> <Kind> <Size> (<Area>)`, which carried no tier and put
the kind before the size. That shape had replaced `P<n> · <area>/<surface> ·
<statement>` on 2026-09-25.

- **Each prefix part copies a label.** The label is the source of truth. The title is
  what a list, a search result, and a notification show. `<Priority>` is the `P0` to `P4`
  label. `<Tier>` is the `MODEL:` label, `T1` to `T4`. `<Size>` is the `SIZE:` label, `XS`
  to `XL`. `<Kind>` is the `KIND:` label: `Bug`, `Feature`, `Improvement`, `Chore`,
  `Documentation`, or `DevOps`. `<Area>` is the title name of the one `AREA:` label.
  Retitle whenever one of those labels changes.
- **The statement** says what goes wrong for a bug, and what a person will be able to do
  for a feature or an improvement. Write it for a reader who has never opened the
  codebase: no function names, paths, or internal terms. Aim for 80 characters and never
  exceed 100. Follow `clear-prose`, and do not write "Mission Control" (ADR-113).
- **A lane tag** such as `[C0]` goes at the start of the statement, after the colon.
- **Residue issues** carry their PR in a trailing `(residue #<PR>)`. List every PR when a
  residue issue carries more than one.
- **A workflow-owned issue** (`DEPLOYMENT-FAILURE`, `MAIN-UNVERIFIED`, `INFRA-DRIFT`,
  `STORE-DRIFT`) gets its whole title from the workflow that files it. The triage pass
  keeps that title and adds the labels it names.

`.claude/commands/triage-issues.md` holds the full rules: the tier, size, kind, and area
tables, how to choose each label, and the procedure. Read it before you file an issue.
Run `/triage-issues` to complete every open issue that has no priority label.

## Issues and labels

Track work in GitHub issues on `oxageninc/product`. Follow SCR-003 and SCR-004 in the standing decisions at the end of `AGENTS.md`.

**Assigned work carries an issue.** When you are asked to change functional code, tests, or documentation and no issue covers it, open one before the PR, file it complete as the bullets below say, and cite it in the PR body with `Closes #N` or `Refs #N`. A chore needs none: an edit to rules or agent instructions, a dependency or lockfile bump, formatting, or release bookkeeping. Mac set this on 2026-09-23. SCR-004 below covers a different case, a defect you notice along the way: fix it in the PR, and file it only when it cannot ride.

Fix defects in the task's PR when the fix can responsibly ride it. File an issue only when the work needs a maintainer decision, a rig, credentials, real spend, or more work than the session can carry. State that constraint and the maintainability, stability, reliability, innovation, efficiency, or performance benefit.

One issue carries one full change. Include context, paths, reproduction steps where relevant, a proposed approach, and a `- [ ]` definition of done. Do not create sub-issues, parents, or epics. Use the templates in `.github/ISSUE_TEMPLATE/`.

- A PR uses `Closes #N` only when it finishes every item in that issue's definition of done. Otherwise use `Refs #N`.
- A PR that closes no issue, such as a chore, uses `NO-ISSUE` for a trivial change or `CLOSES-NOTHING` for a substantial change. These are PR labels, not substitute text in the body.
- A PR that changes a schema carries `MIGRATION-REQUIRED` (SCR-006). `migration-label.yml` applies it from the diff. Add it yourself only if the workflow has not, and never remove it while the diff still changes a schema, because the workflow puts it back. Nothing else about the PR changes: `migration-gate` applies the migration on merge.
- File every issue you create complete. Write the full title from Issue titles above. Apply one priority, one `MODEL:`, one `SIZE:`, one `KIND:`, and one `AREA:` label, plus the labels below that apply. Set the issue type to the kind (`gh issue create --type Bug`), and set the fields Oxagen issue fields marks for filing. Do not apply `TRIAGE`. Mac set this on 2026-10-02. Never apply workflow-owned labels manually.
- Add no attribution to an issue, an issue comment, or a PR: no "Generated with Claude Code" footer, no `claude.ai/code` session link, and no co-author line. Mac had them stripped from every issue on 2026-09-25.
- CI files a `P0` issue labelled `DEPLOYMENT-FAILURE` when `main` goes red or a production deploy fails, and closes it when a later run recovers (`.github/workflows/deployment-failure.yml`). This is the one priority label a workflow applies. Record the root cause and the fixing commit (it lands straight on `main`, per AGENTS.md under Git Workflow) in a comment, and leave the open and close to CI, because the time between them is the recovery-time statistic.
- Close an issue as completed only with verification. Use not planned with an explanation for duplicates, superseded work, or a decision not to proceed.
- Follow the review severity and three-round residue rules in `AGENTS.md` under Git Workflow. That file owns the rule, including the fourth-round P1 exception and the P0 block. On a PR labelled `AGENT-MONITORED-PR`, the pass rule replaces the round rule.

Two facts have no label and no issue field. Record them in an `Issue metadata` section of
the issue body, with each name and its value, when you open the issue. Correct them when
you learn better:

| Entry | Type | What it records |
|---|---|---|
| Breaking change | Yes / No | The change alters a capability contract, an API response, a CLI flag, a hook payload or a stored format that a consumer already depends on. |
| Customer reported | Yes / No | A customer or prospect reported the problem. An audit, a reviewer, CI or telemetry did not. |

An issue whose work alters a Postgres, ClickHouse or Neo4j schema carries the
`MIGRATION-REQUIRED` label, the one its pull request gets from `migration-label.yml`. Apply
it once you know, at the latest when your run ends. Mac set this on 2026-10-02. It replaced
the `Impacts schema` body entry and, later that day, the Requires Migration and Schema
Changes issue fields.

Mac set this label scheme on 2026-09-30 for oxagen and stella, and every label name is
uppercase. A complete issue carries exactly one priority, one `MODEL:`, one `SIZE:`, one
`KIND:`, and one `AREA:` label:

| Dimension | Values |
|---|---|
| Priority | `P0`, `P1`, `P2`, `P3`, `P4` |
| Tier | `MODEL:T1` (Haiku: mechanical, fully specified work), `MODEL:T2` (Sonnet: routine implementation from a clear spec), `MODEL:T3` (Opus: judgment across packages, invariants, security, or migrations), `MODEL:T4` (Fable: architecture-critical or novel design) |
| Size | `SIZE:EXTRA-SMALL`, `SIZE:SMALL`, `SIZE:MEDIUM`, `SIZE:LARGE`, `SIZE:EXTRA-LARGE` |
| Kind | `KIND:BUG`, `KIND:FEATURE`, `KIND:IMPROVEMENT`, `KIND:CHORE`, `KIND:DOCUMENTATION`, `KIND:DEVOPS` |
| Area | `AREA:FLEET`, `AREA:RUNS`, `AREA:MANDATES`, `AREA:AGENTS`, `AREA:TOOLS`, `AREA:STEERING`, `AREA:SKILLS`, `AREA:SPEND`, `AREA:BILLING`, `AREA:ORGANIZATION`, `AREA:AUTH`, `AREA:ONBOARDING`, `AREA:REPOSITORIES`, `AREA:STELLA`, `AREA:APP-SHELL`, `AREA:TACHO`, `AREA:DESKTOP`, `AREA:GATEWAY`, `AREA:API`, `AREA:MCP`, `AREA:CLI`, `AREA:DATABASE`, `AREA:CI`, `AREA:DEPLOY`, `AREA:DOCS`, `AREA:COMPLIANCE` |

Add these where they apply:

| Dimension | Values |
|---|---|
| Job | `JOB:GOVERN`, `JOB:GROUND`, `JOB:EXPLAIN`, `JOB:METER`, `JOB:RATE` |
| Pillar | one or two of `PILLAR:STABILITY`, `PILLAR:RELIABILITY`, `PILLAR:MAINTAINABILITY`, `PILLAR:INNOVATION`, `PILLAR:EFFICIENCY`, `PILLAR:PERFORMANCE` |
| Need | `NEEDS:DECISION`, `NEEDS:RIG` |
| Other | `SECURITY`, `BLOCKED` |

A `SIZE:` label is the band of agent minutes the work should take to reach a merge-ready
pull request: XS is 30 or fewer, S is 31 to 90, M is 91 to 240, L is 241 to 480, and XL
is more than 480. Move up one size for high risk or a wide blast radius. The Estimated
Minutes issue field holds the same estimate as a number (see Oxagen issue fields below).

The area names where a person meets the problem, not the package that holds the code. Add `SECURITY` when the issue involves credentials, secrets, tenant isolation, access control, or personal data.

A bug is something that exists and behaves wrongly. A feature adds a capability none of which exists yet, with a rationale against `docs/VISION.md`. An improvement makes an existing capability better, and a gap where the spec or mockup shows more than the build has is an improvement. A chore is maintenance with no visible change. Documentation and DevOps name their deliverable. A decision belongs in an ADR. Use `NEEDS:DECISION` only when the body asks the maintainer a specific question and the work waits on the answer. Read `gh label list` for current labels and descriptions.

Mac reinstated the `MODEL:` tier labels on 2026-09-30. This supersedes the 2026-09-25 retirement of `model:tier-*`, which left the choice of model to the harness.

Do not apply these: any lowercase label (the 2026-09-30 scheme renames each one to its uppercase name), `kind:gap` (now `KIND:FEATURE` when nothing is built, `KIND:IMPROVEMENT` when part is), `build-time:*`, `schema-change` (PRs use `MIGRATION-REQUIRED`), and the code-owner areas `area:app`, `area:data`, `area:evidence`, `area:kernel`, `area:knowledge`, `area:ops`, `area:platform`, and `area:surfaces`, which have no uppercase successor. GitHub matches a label name without regard to case when you add or filter one. Every issue and PR payload still carries the stored spelling, so code that reads a label compares the names lowercased.

`check:manifest:tickets` and `e2e:failure-ticket` still target Linear and no-op without `LINEAR_API_KEY`. Issue #2980 tracks their move to GitHub. `linear-release.yml` publishes release notes and is separate from issue tracking.

## Documentation maintenance

Keep active instructions close to their source. Use `docs/README.md` to navigate internal docs and `apps/docs/content/docs/` for published instructions. Update capability docs when contracts change, including their registered names, surfaces, and index entries.

Do not copy package counts, dependency versions, route lists, or old gap counts into additional documents. Link to the manifest, route oracle, check output, or owning source instead. Preserve useful decisions and incident records with their dates. Remove duplicate copies and repair their inbound links.

## Oxagen issue fields

Mac set this on 2026-10-02 for every repository in an Oxagen organization (`oxageninc`, `ox-product`, and any later one). Each of these organizations carries the same issue fields, and they hold what a label cannot. The reference is `issue-management.html` in `oxageninc/roadmap`, built from `issue-management/issue-fields.json` there. It holds every field's options, including the grading scale. Each field has a label, which GitHub shows, and a snake_case name, which docs and code use.

| Label | Name | Set |
|---|---|---|
| Priority | `priority` | Filing. It matches the `P` label |
| Model Tier | `model_tier` | Filing. Lite is T1, Standard T2, Pro T3, and Ultra T4 |
| Area(s) | `areas` | Filing. One or more names from the `AREA:` labels |
| Minutes Estimated | `minutes_estimated` | Filing |
| Minutes Actual | `minutes_actual` | Run end. Add your minutes to the value already there |
| Blocked | `blocked` | Yes while the work waits on a maintainer decision |
| Blocked Reason | `blocked_reason` | With Blocked set to Yes. Each open decision as a question |
| Agent Self Reflection | `agent_self_reflection` | Reflection |
| Agent Self Grade | `agent_self_grade` | Reflection. A to F |

- **Minutes are plain integers.** Count the agent minutes spent building the change or watching its PR, up to the point where the PR is ready for review with CI green. Do not count the wait for review or merge.
- **An issue shows the fields in the table's order.** Every issue type pins them that way. `tools/sync-issue-fields.mjs` in oxageninc/roadmap lists a type that drifts, and the order is set on the organization's issue types settings page, because no API sets it.
- **Record the reflection when your run ends.** In one pass, add your minutes to Minutes Actual and set Agent Self Reflection and Agent Self Grade. If the work changed a schema and the issue lacks `MIGRATION-REQUIRED`, apply it then.
- **Blocked is the roadmap's list of decisions.** The roadmap app lists every open issue with Blocked set to Yes as a decision for Mac. Set it back to No and clear Blocked Reason once the decision is made. Keep applying `NEEDS:DECISION` as well.
- **The `All issues` board keeps Prompt and Resolution.** The board is a project in the `macanderson` account (`gh project list --owner macanderson`). Put the issue on it, set Prompt when you file the issue, and set Resolution when it closes. Do not write the board's Model Tier, Size, `agent_mins_est`, or `agent_mins`, and do not post the reflection as a comment.
- **Fix any field you find wrong** on any issue you touch.

```sh
gh api orgs/oxageninc/issue-fields --jq '.[] | "\(.id) \(.name)"'                    # field ids
gh api repos/oxageninc/product/issues/<n>/issue-field-values --input values.json     # set fields
```

`values.json` holds `{"issue_field_values": [{"field_id": 123, "value": "Yes"}, {"field_id": 456, "value": ["Runs", "CI"]}]}`.

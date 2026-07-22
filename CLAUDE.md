# CLAUDE.md

## Mission

Oxagen is a metered, governed, graph-grounded control plane for teams that build and resell AI agents. The full positioning and drift tests live in `docs/VISION.md`, the reference for feature direction. The platform centers on three things:

- **Contract governance:** capability-parity typed contracts binding identity → knowledge scope → permitted action → commercial terms → verified outcome → audit record.
- **Graph grounding:** a Neo4j graph + ontology grounding agent answers in cited, time-aware context.
- **Metering → billing:** a ClickHouse→Stripe loop turning observed usage into customer billing.

Vendor-neutral BYOK (own model keys, own Neo4j endpoint) is a design constraint, not an add-on.

- **When recommending or prioritizing features,** prefer work that deepens metering→billing, contract governance, graph grounding, vendor neutrality, or fleet lineage. If a request diverges from that direction, say so and propose the aligned alternative alongside doing what was asked.
- **CI enforcement:** the Vision Gate (`.github/workflows/vision-gate.yml` → `tools/scripts/vision-gate.mjs`, `pnpm check:vision`) LLM-judges every PR diff against `docs/VISION.md` and posts an advisory verdict (advances / neutral / drifts). A `drifts` verdict signals to justify the exception in the PR description or redirect the work — routine maintenance, fixes, tests, and tooling are neutral by definition.

## Prime directive — fix every issue you encounter

When you encounter a bug, broken path, dead value, mispriced meter, stale config, or any defect — **fix it now, in place, completely.** Investigate to root cause, fix every co-located instance, and verify with tests/typecheck before declaring done. The only acceptable deferral is a true external action you cannot perform (e.g. flipping a prod env var) — and even then, fix everything in code first.

## Operating mode — branch early, commit often, push regularly, open a PR

`main` is a **shared, contested branch.** Multiple Claude sessions and an automated optimizer work this same tree in parallel. **Never commit or push directly to `main`** — every body of work lives on its own branch, pushed to the remote, with a pull request open against `main`. Test suites no longer run in git hooks (they run in CI on every PR and push), so pushing is cheap and safe — push early and often.

- **Branch early and push it immediately.** The moment you start a body of work, cut a branch from a fresh, synced `main` and push it to the remote (`git push -u origin <branch>`). This backs the work up and makes it visible to the other sessions right away, before you've written much.
- **Commit frequently, push regularly.** Commit in small increments as you go — at every meaningful step, not just at the end — and push after committing so the remote branch stays current. Don't hoard a giant uncommitted or unpushed change. A work-in-progress branch that's pushed beats a perfect change sitting on your disk.
- **Open a pull request for your work.** Open a PR against `main` (a draft early on is fine) and keep pushing to it. The PR is where CI runs the full affected gate and where the work gets reviewed and merged.
- **Don't over-optimize for cleanliness.** Many agents touch this tree at once, so unrelated changes will occasionally land in the same branch or PR by accident, and commit history will be messy. **That is fine and expected.** Do not rebase, squash, or cherry-pick to "tidy" shared history, and do not block on perfect commit or PR boundaries. Correct, complete, pushed work beats a pretty history every time.
- **Never burn CPU on redundant or parallel heavy runs.** Verify with the **narrowest** command that proves the change — a single package's `test:unit` / `test:coverage`, or one test file — not a whole-repo run. Before launching anything heavy, check for an in-flight run (`pgrep -fl vitest`, `pgrep -fl lefthook`) and **wait** rather than stack on top of it. Never run two full suites at once.
- **NEVER run all tests — this is a hard rule for every agent and subagent.** Do not run `pnpm test`, `turbo run test`, a whole-repo `pnpm gate`, or any all-package/all-file suite. Run ONLY the specific tests obviously implicated by the files you changed: map each changed file to its nearest test and run just that file or that one package's `test:unit` (e.g. `pnpm --filter @oxagen/billing test:unit -- grants.test.ts`). Subagents make edits and write tests but do **not** execute suites unless explicitly told to run one specific file. The full gate runs in CI on every push and PR — that is the authoritative gate, not your laptop. When you dispatch any subagent, restate this rule in its prompt verbatim.
- **Always start from a fresh, synced cut of `main`:**
  1. `git fetch origin`.
  2. If `origin/main` is ahead of local `main`, bring local up first: `git switch main && git rebase origin/main`, and **resolve any rebase conflicts** before continuing.
  3. If local `main` already matches `origin/main`, skip the rebase.
  4. Cut the branch (or worktree) from the now-current local `main`.
- **Use a git worktree for any large body of work — do this autonomously, do NOT ask.** `git worktree add ../oxagen-<slug> -b <branch>` off the fresh cut of `main`; do the work in isolation, commit and push frequently, and open a PR. Small, single-file, sequentially-dependent edits may stay in the main workspace on a branch.
- **Dangerous, breaking edits are allowed.** Non-negotiable: **everything committed must be functionally complete** — fully wired end-to-end, every layer present, tests passing, no dead code.

## Test gate enforcement

Every code change must leave the package's test suite at or above its `vitest.config.ts` `coverage.thresholds`.

- **New code requires new tests.** Route handlers, contracts, utilities — all need tests before the commit lands.
- **E2E parity.** Any user-facing flow added or changed needs an e2e test in `apps/app/e2e/`.
- **Thresholds are ratchets capped at 90 — never lower them.** When new tested code raises coverage, bump the threshold only up to `floor(current coverage − 2.5)`, so the gate always keeps **at least 2.5% headroom** below actual coverage (razor-thin gates fail CI on environment noise). Never bump unless that headroom holds, **never past 90** (once a metric is at or above 90%, its gate floor is 90 and stays there), and never reduce a threshold below its current value.
- **Run `pnpm gate` before marking a PR ready to merge.** Lint (`--max-warnings 0`), typecheck, coverage, tests, builds, migrations — all must pass locally. (This is a pre-merge gate, not a per-commit one — commit and push freely as you work; run the full gate once the body of work is finished.)
- **Lint is part of the gate.** Zero ESLint warnings; no `eslint-disable` unless genuinely inapplicable (inline comment required).

## Verification discipline

Never claim a task is complete without concrete verification. Always provide evidence: test output, CI status, or rendered result.

- **No task is done until verified.** State what verification you ran and its output.
- **Verification is required for everything — save the proof.** Every task you do, not just UI work, must produce concrete verification artifacts (test/command output, CI status/logs, screenshots, DB query results, API responses). Write those artifacts into a `verifications/` directory at the repo root, inside a subdirectory named after your Claude Code session id — i.e. `verifications/<claude-session-id>/` (e.g. `verifications/session_01Y8Eqm6L7KJhRmBsBx39vH6/`). Name each file by what it proves (e.g. `cli-docs-account-setup.png`, `migration-select-after.txt`). The `verifications/` directory is gitignored, so these artifacts stay local and never bloat shared history.
- **UI changes require screenshots.** E2E tests must capture screenshots of key success states. Delete and recreate the screenshot directory on every run; add it to `.gitignore` (e.g. `apps/app/e2e/screenshots/`).
- **Forms must be tested end-to-end.** Submit data, verify success via DB query or API response.
- **Deployments must be verified.** Health check, DB query, or API call after deploying — not just deploy logs.
- **DB changes must be verified.** Run a `SELECT` after migration to confirm changes landed.

## Golden rule — the three-command gate

**Before marking a finished body of work ready to merge, ALL THREE of the following must pass locally with no errors:**

```bash
pnpm i --no-frozen-lockfile          # sync lockfile; run after any dep change
pnpm build                           # full monorepo build from repo root
pnpm kill && pnpm dev                # clean start; all dev servers must come up without error
```

Then run the full test suite:

```bash
pnpm gate                            # lint + typecheck + coverage + tests + migrations
```

**If you hit a "port already in use" error, run `pnpm kill` first**, then retry.

This gate is non-negotiable. Do not mark the work ready to merge until all four commands succeed. (Incremental commits and pushes to your branch during the work do not each need the full gate — that would mean running all tests, which is banned; the gate is a pre-merge check.)

## Dependencies

- **Always add external package dependencies to the correct `package.json`** — the app or package that imports the dep, not the monorepo root. Never hoist a dep to the root just for convenience.
- **Run `pnpm i --no-frozen-lockfile` after any dep addition or removal** to update the lockfile before committing.
- **Do not add a dep to multiple packages** if it can be shared via a workspace package.

## CI / Build

**Before marking a PR ready to merge:**
1. Run the three-command gate above — build, dev, and `pnpm gate` all pass.
2. Verify `.env.example` and lockfile are in sync.
3. CI runs on every push and PR; after you push, confirm it green via `gh run watch`.

## Database and migration targeting

Before running any mutation/migration script, **confirm you are targeting the correct database.**

- **Migration files go in `packages/database/atlas/migrations/`**, never in `apps/`. After adding or renaming one, regenerate the checksum: `atlas migrate hash --dir "file://atlas/migrations"` from `packages/database` (never hand-edit `atlas.sum`). Pick a timestamp prefix later than every existing file AND later than the shared local DB's current version — parallel sessions collide otherwise.
- **Echo the target DB URL before any mutation script.** Local = `localhost:5433`; prod = Vercel secrets.
- `tsx --env-file=.env.local` does NOT override a shell `DATABASE_URL` — `unset DATABASE_URL` to force local targeting.
- **Verify with a query after migration.** Don't trust logs alone.

## Subagent workflows

- **Use writable agents.** Architect agents return blueprints only; use `general-purpose` or equivalent for file edits.
- **Grant full find-and-fix permissions.** Bug-fix workers must be able to diagnose, fix across files, run tests, and commit.
- **Subagents commit and push too.** They commit frequently on the working branch/worktree, same as you; the session that owns the branch keeps it pushed and opens the PR. When dispatching a subagent, tell it which branch it is on.
- **Dispatch the test-completeness-judge before committing a finished body of work.**
- **Verify agents actually committed.** Run `git log -5 --oneline` (and `git status`) on the branch/worktree. Do not accept "committed" claims without this.

## Large file handling

For files >50k tokens, do NOT read the whole file. Grep or slice first:
- `grep "pattern" file | head -50` for matching lines
- `sed -n '/START/,/END/p' file | head -100` for sections

## Completion workflow — branch, commit, push, open a PR

1. Cut a fresh, synced branch/worktree from `main` (see **Operating mode** — fetch, rebase local `main` onto `origin/main` if behind, resolve conflicts, then cut) and **push it to the remote immediately** (`git push -u origin <branch>`).
2. Implement all code changes, **committing and pushing frequently** as you go.
3. Write unit tests for all new/changed logic.
4. Write E2E tests for user-facing changes (screenshots to `e2e/screenshots/`).
5. Run `pnpm gate` — all gates green.
6. Dispatch **test-completeness-judge** to audit coverage. Re-run until APPROVED.
7. Push the final commits and **open (or mark ready) a pull request against `main`.** Confirm CI green via `gh run watch`. Don't fuss over perfectly clean commits or a perfectly scoped PR — see **Operating mode**.

## Working with this user

Multi-part prompts are the norm. **Decompose immediately and dispatch subagents in parallel for independent work.** Never serialize independent tasks.

**Delegation is the default for any work > 2 tool calls.** Pattern:
1. Parse → decompose → dispatch in one message.
2. Multi-step chunk → agent. Trivially small → inline parallel tool calls.
3. Keep work in parent only when steps are small AND sequentially dependent.

Decomposition:
- Research / investigation → agent (context isolation)
- File edits in known locations → inline parallel tool calls
- Codebase breadth search → `Explore` agent
- Different repo/system → its own agent

## Project skills

`.agents/skills/` auto-registered via `.claude/skills/`. Consult before writing code.

- **`oxagen-engineering-policy`** — binding law. Non-negotiables, four-store data model, SQL conventions, bloat/vendor/naming, observability, PR discipline. Consult BEFORE writing/changing code, picking a dep, designing a schema, writing tests, opening a PR, or touching CI. Halt and surface conflicts — do not weaken the rule.
- **`coss-ui`** — `@oxagen/ui` component system: registry, `render`-not-`asChild`, naming conventions, size scales, shadcn/Radix → coss migration. Use when building UI importing `@oxagen/ui`.
- **`frontend-patterns`** — 136-entry technique library (CSS, a11y, CWV, forms, passkeys, view transitions, privacy, security). Open matching technique files; don't read the whole library.
- **`reablocks`** — tables, timelines, block layouts in `apps/app`.
- **`reagraph`** — WebGL graph visualization (knowledge-graph, lineage, topology).
- **`reaviz`** — d3-backed charts, sparklines, metric visualizations.
- **`oxagen-feature`** — feature scaffolding workflow (contracts → routes → UI → tests).
- **`vendor-better-auth`** — Better Auth llms.txt index. Pair with `*-best-practices` auth skills.
- **`oxagen-code-audit`** — full-repo audit: fan-out → adversarial verify → auto-fix → Linear tickets → HTML dashboard.
- **`test-completeness-judge`** — gates PR opening. Audits unit, integration, E2E coverage with proof. Do not open PR until judge approves.
- **`ci-green`** — full local CI gate, env file sync, push, watch GitHub Actions until green.

Routing: code/schema/test/PR/CI → `oxagen-engineering-policy` first, then `ci-green` to run the full local gate, push, and watch CI green before opening or finalizing the PR.
UI → `coss-ui` + `frontend-patterns` + component libs as needed.
Auth → `vendor-better-auth` + Better Auth `*-best-practices`. New features → `oxagen-feature`.

## Production URLs (interim)

- App: `https://app.oxagen.sh`
- API: `https://api.oxagen.sh` (Hono REST; no MCP protocol endpoint)
- MCP: `https://mcp.oxagen.sh` (connect at `/mcp` over streamable HTTP; org+workspace scope carried by API key)
- Docs: `https://docs.oxagen.sh`

Use oxagen.sh domains in OAuth callbacks, env values, allowedOrigins, docs. Keep URLs isolated to env vars — oxagen.sh domain migration is a single env-var sweep.

## Linear

Project: `oxagen-v2`. API key in repo root env.

**Ticket convention:**
- **One ticket = one PR.** Sub-issues for chunks within the ticket (3–6 per parent).
- **Assignee: Mac Anderson** (`mac@oxagen.ai`, `aa47fc28-1b3a-4b45-bb02-d18f2e59c6bb`).
- **Labels:** Call `list_issue_labels` — don't guess. Active ~28 slugs: `web-app`, `mobile-ux`, `api`, `mcp`, `knowledge-graph`, `ingestion`, `connectors`, `agents`, `agent-memory`, `content-studio`, `llm`, `automation`, `auth`, `billing`, `security`, `soc-2`, `observability`, `infra`, `ci`, `database`, `performance`, `reliability`, `bug`, `epic`, `tech-debt`, `testing`, `user-docs`, `adr`. Defunct (do not use): `agent-created`, `foundations`, `application-shell`, `iam`, `SOC2`.
- **Estimate:** XS(1)≤1h · S(2)half-day · M(3)1day · L(5)multi-day · XL(8)week+. Size on largest of risk / blast-radius / effort.
- **Priority:** P1=Urgent (blocks others) · P2=High (next quarter) · P3=Medium · P4=Low.
- **Description:** purpose sentence · spec.md link · explicit file/migration list · acceptance checklist · risks+mitigations · rollback plan.

## Operating model

**Default model: Haiku.** Escalate explicitly.

| Stay on Haiku | Escalate to Sonnet | Escalate to Opus |
|---|---|---|
| Single-file edits, reads, lookups, formatting, dispatch, summarizing | >3 files or cross-package; ambiguous requirements; non-trivial new logic; non-obvious debugging; diff review | Architectural decisions; storage boundary changes; security (auth/billing/secrets); multi-system (MCP+API+app); production incidents |

**Parallelism:** Dispatch in parallel when genuinely independent. Do not parallelize when steps have dependencies, touch the same files, or dispatch overhead exceeds gain.

**Dispatch table:**

| Prompt signal | Action |
|---|---|
| Rename / format, single file | Inline parallel tool calls |
| Fix / add ≤5 files, one package | Haiku subagent |
| Fix / add crossing packages (>3 files) | Sonnet subagent |
| Design / architect / broad refactor | Sonnet; Opus if security/auth/billing |
| Auth / billing / security / multi-system | Opus subagent |

**Context budget:** Delegate to shed context. Pass only file paths, error excerpts, relevant lines. Summarize results; don't quote raw output. Use `/compact` before starting a new logical unit if context is heavy.

**Cost discipline:** Match model to task. Use `pnpm check:manifest --json` for contract introspection. The `ontology.*` graph query layer **is wired** — `ontology.neighbors` and `ontology.query` have contracts, API routes, and MCP tools; call them via `invoke()`/the contract, never Neo4j directly. `agent.code.execute` IS wired; use the contract, not raw `code.*` calls.

## Local frontend verification

Authorized and encouraged every session without asking permission. Use `creds.json` at repo root (gitignored — never commit or print the password).

**Stack:** `apps/app` → `http://localhost:3000`, `apps/docs` → `http://localhost:3300`, API → `:4000`, MCP → `:4100`. Local Postgres on `:5433`. `pnpm dev` starts all apps + Docker.

**Login:** Email+password only (no email verification locally). New user → `/signup` → `/new-organization` → create org → `/{org}/{ws}/ask`. Returning: `/login`.

**Browser:** Prefer chrome-devtools MCP (`mcp__plugin_chrome-devtools-mcp_chrome-devtools__*`). The chrome-devtools `fill` tool appends to inputs — to set a React-controlled field, use `evaluate_script` with the native value setter + a bubbling `input` event.

## Key dependency versions

- **Next.js `16.2.7`** — App Router, Turbopack default. `proxy.ts` replaces `middleware.ts`.
- **AI SDK `ai@6.0.x`** — use `modelIdOf()` for model resolution. `streamText`/`generateObject`/`generateText` are correct. `ai/rsc` (`streamUI`, `createStreamableUI`, `createAI`) is **forbidden**. `@ai-sdk/react` permitted for non-chat client surfaces only.
- **TypeScript `6.0.3`** — no `any`.

## App stack

### `apps/app`
- Next.js App Router, RSC, streaming.
- AI via Vercel AI SDK Core (`streamText`/`generateText`/`streamObject`/`generateObject`) on server. **Never `ai/rsc`.**
- Main chat path: `POST /api/v1/chat/stream` SSE consumed by `use-tool-stream.ts` (`apps/app/src/components/chat/use-tool-stream.ts`). Do not add a second transport. `@ai-sdk/react` only for non-chat surfaces.
- Generative UI: model returns `generateObject` structured output; client maps to React components via chat component registry. No server-rendered React trees.
- **Request interception: `proxy.ts`** at `apps/app/src/proxy.ts`, not `middleware.ts`. Edge-safe only: cookies, URL rewrites, redirects. No Node built-ins, DB calls, or secrets.

### `apps/api`, `apps/mcp`
- `apps/api` — Hono REST. Routes at `apps/api/src/routes/v1/<capability>.ts`.
- `apps/mcp` — xmcp. Tools at `apps/mcp/src/tools/<capability>.ts`. Connect at `/mcp`.
- **Capability parity rule:** new user-facing action → contract in `packages/oxagen/src/contracts/` → API route → MCP tool → CLI command. Run `pnpm check:manifest` to verify.
- **Contract-wiring order is law:** a new user-facing section must NOT be wired to live data until a contract exists — always contract → API route → MCP tool → UI wire-up. Do not shortcut a page straight onto a raw query.
- **UI Capability Parity is law (as strong as capability parity):** if a capability is invocable on any non-`app` surface (api / mcp / cli) **and** is meant to be operated by a human in the app, then the app MUST contain real UI that actually invokes it and works — no error page, no dead route, no missing screen. A capability whose app surface is missing or broken is **NOT feature-complete and MUST NOT be merged**, exactly like a missing API route or MCP tool. Mechanism:
  1. The capability's contract declares `app` in its `layers[]` — the promise that a human can operate it in `apps/app`.
  2. It has a binding in `apps/app/capability-ui-map.json` → `{ route, page, entry, proof }`, where `page` exists and `proof` points at a runtime artifact (a screenshot committed under `verifications/<session>/`, or an `apps/app/e2e/<slug>.spec.ts`) captured against a **working, non-erroring** page.
  3. `pnpm check:ui-parity` enforces it. **Forward gate** (`--strict` fails CI): every `app`-layer capability must be bound to an existing, proven page. **Reverse advisory** (warn-only): every capability the app actually invokes (`invoke(<contract>.name, …)`) but does not declare `app` for is flagged — either promise + wire it, or it is internal plumbing behind another surface. Wired into `pnpm gate`. Run `pnpm check:ui-parity --json` to see `{ forward, reverse }`.
  4. Prime-directive corollary: encountering an app surface that 404s / throws / renders a placeholder for a capability that works elsewhere is a **defect to fix now** — wire the UI or, if the build is large (Opus/Fable-tier), open a sub-issue under the `UI Capability Parity` milestone in Linear before moving on. Never ship the dead surface.
- **Mostly-wired-now (verified 2026-07-04, do NOT treat as mock):** the `access/*` (sessions, reviews), `developer/*` (mcp, tokens), and `security/*` (compliance, audit, mfa) app sections under `apps/app/src/app/[orgSlug]/` are real — they have server `actions.ts` backed by contracts/handlers, with unit tests. `security/compliance/page.tsx` explicitly notes "No more mock data." The `activity/` routes under `apps/app/src/app/[orgSlug]/[workspaceSlug]/` were reintroduced (verified 2026-07-09) as real Suspense-streamed pages backed by `agent.execution.list` — treat them as live, not mock; the old "activity.*"/"tools/studio.*" mock warning stays obsolete, and there are still no `tools/studio/` routes. The `security/page.tsx` posture dashboard itself reads live data, but it honestly flags the controls that are genuinely not built yet — org-wide MFA / SSO enforcement is "not yet configurable" and the backup-restore drill is "not yet on file" — so those specific controls, plus a few `knowledge.*` / billing / settings / profile surfaces still awaiting their contract, remain unwired until the contract/feature lands, per the rule above.
- **`check:manifest` combined route files:** `tools/scripts/check_manifest.mjs` content-scans `apps/api/src/routes/v1/*.ts` (contract imports + literal capability-name matches) as a fallback beyond per-capability filename existence, so a capability dispatched from a combined multi-capability route file no longer reports as a false-positive `api` gap — no manual verification needed before filing a parity ticket. Where these families live: `workflow.ts` (`workflow.run/cancel/status`), `connection.ts` (all 10 `connection.*`: create/delete/get/list/mappings.get/mappings.set/mappings.suggest/pause/preview/update), `integration.ts` (all 7 `integration.*`), `repo.ts` (all 13 `repo.*`: branch.create/ci.status/configure/create/file.put/fork/metrics/pause/pr.diff/pr.get/pr.open/resume/sync, plus `agent.repo.edit` = 14 total), `semantic-edge.ts` (all 4 `semantic.edge.*`), `schema.ts` (all 22 `schema.*`), `plugin-schema.ts` (`plugin.schema.get/validate` + `plugin.version.list`), `reseller.ts` (all 15 `billing.reseller_*` capabilities). Note: `semantic-relationship.ts` and its 4 `semantic.relationship.*` capabilities were deleted in commit `1e54acd6` — do not reference that file, it no longer exists. All surviving combined files are mounted in `apps/api/src/app.ts`. To see only genuine surface gaps (ignore docs/unit/e2e-only entries): `pnpm check:manifest --json` and filter for gaps whose `missing` includes `api` or `mcp`.

### `apps/cli`
Commander + Ink. Entry: `apps/cli/src/index.tsx`. Command modules live in `apps/cli/src/commands/` (count drifts — do not hard-code it). `oxagen dev` is the dev-stack launcher.

### `apps/docs`
Fumadocs/MDX. Statically generated. No interactive runtime.

## Common commands

```bash
pnpm dev                         # start all apps + Docker (Postgres :5433, ClickHouse :8123, Neo4j :7687)
pnpm typecheck                   # run TS across the monorepo
pnpm test                        # DO NOT run directly (see "NEVER run all tests"); use `pnpm --filter <pkg> test:unit -- <file>` for narrow runs
pnpm check:manifest              # verify API↔MCP capability parity (warn-only)
pnpm check:manifest --json       # machine-readable parity output
pnpm check:contracts             # verify contract definitions
pnpm env:check                   # validate .env.local against schema
pnpm release:patch               # bump patch version, tag, sync PLATFORM_VERSION to Vercel
pnpm release:minor               # bump minor version
pnpm release:major               # bump major version
pnpm db:migrate                  # apply pending Postgres migrations
pnpm db:lint-migrations          # verify migration file names and checksums
pnpm db:seed-iam                 # seed IAM roles and permissions
pnpm db:seed-skills              # seed agent skill definitions
pnpm db:backfill-iam             # backfill org IAM for existing orgs
pnpm gate                        # run full CI suite locally (lint + typecheck + test + build)
pnpm kill                        # kill all background processes
pnpm env:pull                    # pull Vercel env vars to .env.local
pnpm billing:stripe-sync         # sync meter pricing and discounts with Stripe
lsof -ti:3000                    # check if app dev server is running
lsof -ti:4000                    # check if API server is running
lsof -ti:4100                    # check if MCP server is running
git fetch origin && git rebase origin/main  # on main: sync local to remote before cutting a branch
```

## Gotchas

- **`"use client"` boundary** — never call a `"use client"` function from a Server Component.
- **`invoke()` needs handler registration** — `import "@oxagen/handlers/register"` before any `invoke()` call; forgetting silently no-ops metering/IAM.
- **Turbopack extensionless imports** — `import Foo from "./Foo"` not `"./Foo.tsx"`.
- **`proxy.ts` not `middleware.ts`** — `middleware.ts` is no longer recognized.
- **Raw `db()` is banned** — use `withTenantDb` / `withSystemDb` / `scopedSession`. `FORCE RLS` requires the `oxagen_app` non-superuser role.
- **Rebase before cutting a branch** — `git fetch origin`, and if `origin/main` is ahead, `git switch main && git rebase origin/main` (resolve conflicts), then cut your branch/worktree from the updated local `main`. Once your branch is cut, push it and work on it; don't rebase shared branch history to tidy it (see **Operating mode**).
- **`apps/app` does not bootstrap IAM** — `invoke()` from `apps/app` skips IAM role checks. Add explicit `assertBillingManager` / `assertOrgMember` gates at the call site; do not rely on the kernel.
- **Better Auth `rateLimits` plural** — `drizzleAdapter` with `usePlural: true` pluralizes `rateLimit` → `rateLimits`. Wrong table = 500 on all auth calls in prod (passes dev/e2e since rate-limiting is disabled locally). Always verify auth changes against a prod-equivalent environment.
- **`tsx --env-file` does NOT override shell `DATABASE_URL`** — `unset DATABASE_URL` for local targeting. Always confirm target env before any migration. Migration files go in `packages/database/atlas/migrations/`, never in `apps/`.
- **Stripe webhook tunnel** — `pnpm dev` auto-starts the tunnel. Restarting `apps/api` in isolation loses the per-session signing secret — restart the full stack via `pnpm dev`.
- **AI Gateway slug drift** — always use `modelIdOf()`, never hard-code slugs. Verify against `/v1/models` for new models.
- **`agent.subagent.dispatch` / `agent.subagent.aggregate`** — use these contracts for fan-out; they emit lineage and metering through `invoke()`. Don't hand-roll fan-out.
- **`prompt.settings.read` / `prompt.settings.write`** — for system-prompt customization, use these contracts (metered, IAM-gated, org+workspace scoped). Don't hard-code strings.
- **`agent.ui.render`** — `generateObject` structured output only; client maps to React via chat component registry. No `ai/rsc`. Agent surface only — `check:manifest` false-positive gap expected; do not add an MCP/API wrapper.
- **`bootstrapEntitlementRuntime()` required at startup** — any new runtime (server, worker, script) that invokes capability-gated handlers must call `bootstrapEntitlementRuntime()` from `@oxagen/plugins` at startup; forgetting silently skips the entitlement gate.
- **Turbo halts on first failing coverage package** — multi-package coverage failures are masked. Use `turbo run test:coverage --continue` to see all failures at once.
- **Shell-exported env shadows `.env.local`** — a corrupted shell-exported `DATABASE_URL` / `MODAL_RUNNER_URL` / `ANALYTICS_URL` silently overrides `.env.local`. Prefix scripts with `env -u DATABASE_URL …` until the terminal is restarted.
- **GitHub Actions env vars don't reach turbo tasks** — workflow `env:` values are stripped unless the var is listed in the task's `env[]` in `turbo.json`. Always update `pipeline.yml` AND `turbo.json` together.

## All LLM calls must go through `@oxagen/ai`

Never import `generateText` / `streamText` / `generateObject` directly from `ai` inside a handler or route. Always use `@oxagen/ai` re-exports — they emit metering, duration tracking, surface tagging, and prompt hashing to ClickHouse.

## UI component import convention

**Never import `@oxagen/ui/components/*` directly in app code.** All Next.js apps must import UI components from their local re-export layer (`@/components/ui/<name>`), not directly from `@oxagen/ui/components/*`. The re-export layer (`src/components/ui/*.tsx`) is the sole place that touches `@oxagen/ui/components/*` — it's a cheap override escape hatch.

```ts
// ✅ import { Button } from "@/components/ui/button"
// ❌ import { Button } from "@oxagen/ui/components/button"
```

Enforcement: `no-restricted-imports` in `eslint.next.mjs`. Exceptions: the re-export files themselves, plus `@oxagen/ui` barrel, `@oxagen/ui/styles/*`, `@oxagen/ui/lib/*`.

## Citing nodes & edges in the UI

**Never display a node's or edge's UUID as its primary on-screen identifier.** A raw id (`913d6df1-…`) is meaningless to a user. Whenever the UI references a graph node or relationship, cite it by its **human label** (`displayName` + domain `label`) and make the citation **inspectable** — hovering/clicking reveals the full property bag (and a copyable id, which is the only place the raw id belongs).

- **Use the shared citation components**, don't hand-roll a `<span>{id}</span>`:
  - `NodeRef` (`apps/app/src/components/knowledge/graph/node-ref.tsx`) — a colour-coded node chip with a hover/click property popover. Derive its input from an edge with `sourceNodeRef(edge)` / `targetNodeRef(edge)`.
  - The graph-explorer detail/hover panels (`PropertyList`, `ConfidenceMeter`, `CopyableId`, `colorForLabel`) are the canonical primitives — reuse them; there is exactly one implementation of "show a node/edge nicely".
- **Resolve the label server-side.** A capability that returns an edge/relationship must resolve each endpoint to the `knowledgeNodeRef` shape (`{ id, label, displayName, properties }`) in its handler by matching the node in workspace scope and coalescing `displayName→name→publicId`. Don't ship a bare id to the client and hope the UI has a label for it.
- Only materialized, authorized graph records are rendered at launch. A future candidate system must define a separate attributable reference shape rather than overloading a node UUID.

## Infrastructure boundaries

Authoritative. Document architectural decisions in `docs/adr/`.

**Neo4j — graph data only:** ontology/entity relationships, workflow lineage, agent memory, semantic retrieval.

**PostgreSQL — transactional state only:** users, orgs, permissions, billing, configs, job metadata, durable application state.

**ClickHouse — append-only runtime events only:** execution events, logs, metrics, traces, token analytics, tool usage, telemetry.

**File / blob storage — binary assets only:** avatars, generated images/video/documents, uploaded workspace files. Reference row (URL + metadata) lives in Postgres. Driver: Vercel Blob via `@oxagen/storage` (`BLOB_READ_WRITE_TOKEN`).

**Never:** analytics in Neo4j · graph relationships in Postgres · transactional state in ClickHouse · binary payloads in any DB.

**Exception — Connector Dual-Write:** Data connectors write to Postgres (operational record: sync cursor, connection health — source of truth, ACID) and Neo4j (graph index: entities, embeddings, relationships — async Inngest, retryable). ClickHouse observes ingestion events for telemetry.

## Documentation — capability registry

`docs/capabilities/` must stay in sync with live contracts. Manually maintained.

- Update when a contract is added, renamed, or removed. Filename: kebab-case capability name (e.g. `workflow.run.md`). Update `_index.md` for new capabilities.
- Verify `docs/capabilities/` matches contracts in `packages/oxagen/src/contracts/`, `apps/api/src/routes/v1/*`, `apps/mcp/src/tools/*`, `apps/cli/src/commands/*` before committing a finished body of work.
- **Gaps (last audited 2026-06-12):** ~38 contracts missing `docs/capabilities/*.md` (26 tracked by `pnpm check:manifest`; 12 more omit `"docs"` from `layers[]`, so the checker never sees them — add `"docs"` to the contract to track). This count drifts; do not hard-code it.

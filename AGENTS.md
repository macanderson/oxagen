# AGENTS.md

Oxagen is workforce management for autonomous agents, on the shared agent control plane their operators work in (ADR-113, superseding the product name in ADR-067): every agent has its own identity and operates under a mandate — its access, its budget, its tools and skills, its rules — set by the security, FinOps and engineering teams accountable for it and enforced on the actions routed through Oxagen. It is sold to those teams, not to resellers. [`docs/VISION.md`](docs/VISION.md) is the reference for feature direction; CI's Vision Gate (`pnpm check:vision`) judges every PR diff against it.

Oxagen governs agents; it does not run them (ADR-043). Stella is the coding agent; Oxagen is the governor, grounder, explainer, meter and rater. Monorepo built around one primitive: a **capability kernel** that every surface (API, MCP, web app, CLI) calls through a single `invoke()` function — where governance (IAM + entitlement), metering (ClickHouse→Stripe), and lineage are enforced.

## Layout

```
DEREGISTERED.md  the register of de-registered (unreachable, undeleted) features
apps/       customer-facing applications (api, app, cli, desktop, docs, mcp, web, plus app_deprecated)
packages/   shared platform libraries (see each package.json for workspace membership)
tools/      dev tooling (scripts, env-manager, codemods) — also a pnpm workspace member
docs/       VISION.md, capability specs, ADRs, specs (docs/specs)
```

### Apps

| App | Entry | Purpose |
|---|---|---|
| `api` | `apps/api/src/app.ts` | Hono HTTP API + Inngest webhook handler |
| `app` | `apps/app/src/app/` | Next.js 16 enterprise web app (App Router) |
| `mcp` | `apps/mcp/src/` | MCP server exposing contracts that declare the `mcp` surface |
| `cli` | `apps/cli/src/index.ts` | Commander governance-ops CLI over the platform API; former coding-agent commands print a retirement notice |
| `docs` | `apps/docs/src/` | Fumadocs documentation site |
| `web` | `apps/web/` | oxagen.sh public website + `/blog` — hand-authored HTML plus MDX posts from `content/`, built to `dist/`, deployed to S3 + CloudFront |

### Core Packages

| Package | Key File | Purpose |
|---|---|---|
| `oxagen` | `src/kernel.ts` | Capability kernel — the one `invoke()` path |
| `oxagen` | `src/contracts/` | Capability contracts (Zod schemas and metadata; inspect the registry for current names) |
| `oxagen` | `src/iam/resolve.ts` | IAM policy resolution |
| `oxagen` | `src/registry.ts` | Capability registry (`registerCapability`, `getCapability`) |
| `oxagen` | `src/plugins/` | Plugin manifest schema + registry (which plugin claims a contract) |
| `handlers` | `src/register.ts` | All built-in capability handler registrations (lazy-loaded) |
| `agent` | `src/runtime/materialize-tools.ts` | Governed tool materialisation (IAM → entitlement → tool RBAC → consent → approval → telemetry per call), MCP gateway auth, `runGovernedTurn` for the in-app agent |
| `agent` | `src/handlers/` | Agent registry, approval, MCP, memory, role, trace handlers |
| `database` | `src/schema/` | Drizzle Postgres domain schemas. `index.ts` exports the current set |
| `tacho` | `src/` | Leaf package (no `@oxagen/*` runtime dep) that records, gates and evidences agents Oxagen does not run — Claude Code, Agent SDK, custom agents; spec in `docs/specs/tacho/` |
| `steering-assembler` | `src/assemble.ts` | The one assembler (ADR-093): ranks every steering candidate by tier then recency, fits it to a token budget, returns the text and a manifest of what was included or cut and why |
| `inngest-functions` | `src/functions/` | Durable background jobs |
| `ingestion` | `src/pipeline.ts` | Universal connector pipeline |
| `billing` | `src/metering.ts` | Credit gate + usage metering |
| `billing` | `src/grants.ts` | Credit grants + scope |
| `plugins` | `src/entitlements/` | Plugin entitlement gate + bootstrap |
| `plugins` | `src/oauth/` | OAuth provider detection, state store, preregistered clients |
| `plugins` | `src/credentials/` | Workspace credential management + KMS |
| `tenancy` | `src/scope.ts` | `runInTenantScope`, `runWithPrincipal`, tenant context |
| `tenancy` | `src/data-plane.ts` | Organisation-scoped data-plane resolver seam (ADR-042) |
| `run-ledger` | `src/run-store.ts` | Durable run / attempt / event / seal / finalization evidence ledger (was `agent-runner`) |
| `run-evidence` | `src/contextgraph.ts` | CGP conformance + RFC-8785 canonical digests for evidence envelopes |
| `rules` | `src/gate.ts` | Workspace decision-rules gate in the kernel |
| `telemetry` | `src/clickhouse.ts` | ClickHouse client + migration runner |
| `telemetry` | `src/circuit-breaker.ts` | Circuit breaker for telemetry clients |
| `auth` | | Better Auth integration (sessions, rate limits, org members) |
| `iam` | | IAM schema, roles, permissions, policy seeding |
| `ontology` | | Neo4j ontology contracts + graph queries |
| `functions` | `src/types.ts` | Provider-agnostic durable-function contracts that `inngest-functions` implements |
| `glob` | `src/glob.ts` | The one path-glob implementation for the repo (`matchesGlob`, `globToRegExp`) |
| `storage` | `src/vercel-blob.ts` | Vercel Blob + filesystem blob driver |
| `config` | | Shared configuration schema + resolution |
| `crypto` | | Encryption utilities |
| `github` | | GitHub App integration |
| `mcp-config` | | MCP server configuration |
| `notifications` | | Notification dispatch |
| `compliance` | | Audit coverage + security event types |
| `ui` | | Shared component library (`@oxagen/ui`) |

## Capability System

Every feature is a **capability** with a unique verb-first snake_case name (e.g. `send_message`) — ADR-025 retired the old dotted `domain.subject.action` form with **no alias fallback**; contract/route/tool/doc *file* renames are a separate, still-in-progress "file-path realignment phase" (see `docs/specs/adr025-naming-mapping.md`), so many source files still use the old dotted stem even though the registered `name` is verb-first snake_case.

**Adding a capability** — three required files:
1. `packages/oxagen/src/contracts/<name>.ts` — `registerCapability({ name, input, output, surfaces, layers, defaultRoles, ... })`
2. `packages/oxagen/src/contracts/index.ts` — add barrel import
3. `packages/handlers/src/<name>.ts` — handler implementation + registration in `register.ts`

Then wire it into MCP (`apps/mcp/src/tools/<name>.ts`) and CLI (`apps/cli/src/commands/<name>.ts`) if needed.

**Capabilities expose on surfaces**: `api`, `mcp`, `agent`, `cli`. Default: `["api", "mcp"]`.

**The `layers[]` field** is separate from `surfaces[]` — it tracks which artifacts exist for the capability: `schema`, `api`, `mcp`, `cli`, `unit` (test), `e2e`, `docs`, `app`. There is no `agent` layer: the agent surface is declared in `surfaces[]` alone. The `check:manifest` and `check:ui-parity` scripts use `layers[]` to verify parity.

**The `agent` metadata field** on contracts controls agent-facing behavior: `{ requiresApproval, riskLevel, category }`. `requiresApproval: true` pauses the call for a person's approval only on the agent surface, when an in-app agent turn calls it, because the `api` and `mcp` surfaces do not read the flag.

**The `mode` field** is `"sync"` (default) or `"async"`. Async capabilities dispatch long-running work (via Inngest) and return immediately with a status/render payload.

**The `scoped` field** (boolean) indicates whether the capability runs inside `runInTenantScope`. Scoped capabilities require valid `orgId` + `workspaceId` UUIDs.

**Structured output**: some retained contracts return a `render` object (`{ componentId, props }`). Check the consuming surface before relying on it. The rebuilt app uses feature components and data ports under `apps/app/src/features/` and `apps/app/src/data/`; it has no legacy chat component registry.

**Gate injection** (set once at surface bootstrap):
- `setKernelIAMRuntime(checkFn, enforced)` — IAM
- `setBillingAdmissionGate(gate)` — credit check (fires after IAM, before handler; `noBillingGate: true` skips)
- `setCapabilityEntitlementGate(gate)` — plugin entitlement (fires after billing; only for plugin-claimed contracts)

**Handler registration** — handlers are lazy-loaded via `registerHandler(name, () => import('./handler').then(m => m.handler))` in `register.ts`. The entire file is wrapped in `registerHandlersOnce("@oxagen/handlers", () => { ... })` to prevent duplicate-registration on hot reload. **Critical gotcha**: the registered capability `name` (verb-first snake_case) often differs from the handler filename (old dotted stem) — e.g. `ontology.query.ts` registers `"query_ontology"` and `prompt.settings.read.ts` registers `"get_prompt_settings"`. Always check the contract's `name` field, not the filename.

Keep heavy dependencies out of the kernel. Import the handler registration module before `invoke()` or it throws `CapabilityError` with code `no_handler`. Registering handlers does not bootstrap IAM, billing, or entitlement gates. Install those separately at the surface entry point.

## Storage Boundaries

| Store | Use for | Never use for |
|---|---|---|
| PostgreSQL | Transactional state, users, orgs, billing, IAM, config | Analytics, graph relationships |
| Neo4j | Entities, relationships, execution lineage, agent memory | Transactional state, counters |
| ClickHouse | Audit events, token usage, telemetry (append-only) | Mutable state, graph data |
| Blob (Vercel Blob / FS) | Binary assets, avatars, generated images/documents | Transactional state, metadata |

Cross-domain Postgres queries use `src/relations.ts` (Drizzle). Never write raw cross-schema JOINs inside handlers.

**Connector Dual-Write exception**: Data connectors write to Postgres (operational record, ACID) and Neo4j (graph index, async Inngest). ClickHouse observes ingestion events for telemetry.

## Repo-Specific Tooling

| Command | What it does |
|---|---|
| `pnpm dev` | Start all apps + Docker (Postgres :5433, ClickHouse :8123, Neo4j :7687) |
| `pnpm kill` | Kill all background dev processes |
| `pnpm gate` | Verification over packages changed since `origin/main`: lint + typecheck + unit tests + coverage + build, then `check:brand`, `check:manifest`, `check:ui-parity`, `check:mobile-parity`, `check:contracts`, `check:connector-schemas`, `check:contextgraph-fixtures`, `check:mcp-externals`, `env:check`, `db:lint-migrations`, `db:atlas-validate` |
| `pnpm gate:full` | The same over every package (`--concurrency=4`), plus `pnpm test:e2e` |
| `pnpm build` | Full monorepo build via Turborepo |
| `pnpm lint` | ESLint across all packages (zero warnings enforced) |
| `pnpm format` | Biome format (ADR-015; Biome is the sole formatter) |
| `pnpm typecheck` | TypeScript check across monorepo |
| `pnpm check:manifest` | Enforces API ↔ MCP capability parity (`tools/scripts/check_manifest.mjs`) |
| `pnpm check:manifest --json` | Machine-readable parity output (filter for genuine `api`/`mcp` gaps) |
| `pnpm check:ui-parity` | Enforces app-layer capability → UI binding (`capability-ui-map.json`) |
| `pnpm check:mobile-parity` | Enforces mobile feature parity (ADR-026) — no desktop-only features without registered reflow/hidden justification |
| `pnpm check:connector-schemas` | Verifies every built-in plugin connector schema is registered |
| `pnpm check:deregistered` | Asserts every path in `DEREGISTERED.md` §14 still exists — de-registered features must not be deleted without an ADR |
| `pnpm check:contracts` | Ensures every contract file is in the barrel index, every `docs/capabilities` `**Surfaces:**` line matches its contract, and naming compliance |
| `pnpm check:vision` | LLM-judges PR diff against `docs/VISION.md` |
| `pnpm env:check` | Validates `.env.local` against the env registry |
| `pnpm db:migrate` | Apply pending Postgres migrations + seed platform data |
| `pnpm db:lint-migrations` | Verifies Atlas migration file integrity |
| `pnpm db:atlas-validate` | Validates Atlas schema against current DB state |
| `pnpm db:seed-iam` | Seed IAM roles and permissions |
| `pnpm db:seed-platform` | Seed platform defaults (also runs at the end of `db:migrate`) |
| `pnpm check:brand` | Verifies every frontend is on the Oxagen house brand kit (needs the house kit `oxagenai/oxagen-brand` checked out at `$OXAGEN_BRAND_KIT` or `../oxagen-brand`) |
| `pnpm check:naming` | ADR-025 naming compliance |
| `pnpm check:audit-coverage` | SOC 2 audit-event coverage (runs on every PR in CI) |
| `pnpm release:patch/minor/major` | Lockstep version bump (every tracked manifest, whatever its language) + model-written release notes under the clear-prose and oxagen-branding skills (via Vercel AI Gateway; `tools/scripts/lib/release-notes.ts`) + the docs page `apps/docs/content/docs/releases/v<version>.mdx` + git tag. Releases ship from the Release workflow (`.github/workflows/release.yml`, `workflow_dispatch`), which runs this and opens the release PR; see CONTRIBUTING.md → Release Process |
| `pnpm release:patch/minor/major:publish` | The same bump and notes (ending in a link to every installer and executable), then the commit, both tags, the pull request, the CI build of all four desktop targets, and the uploads to downloads.oxagen.sh, npm, and the GitHub release, run from a laptop (`tools/scripts/release-publish.ts`; `--dry-run`, `--publish-only`). Every upload step skips a version that is already there, so it is safe beside the Release workflow |
| `pnpm dist:local` | Build `tacho`, `oxagen`, and the desktop app from this tree for this OS and copy the installer to `~/Desktop` (`--out <dir>`); bumps and publishes nothing |
| `pnpm check:versions` | Every tracked manifest carries the root version, whatever its language (`package.json`, `Cargo.toml`, `Cargo.lock`); `--fix` writes it. Part of `check:contracts` |
| `pnpm test:e2e` | Run the three Playwright specs (`apps/app/e2e`: `login`, `pay`, `page-load`). The suite holds exactly these three and gains no fourth — every other flow is a component test (`.claude/skills/oxagen-testing`, `apps/app/ARCHITECTURE.md` §6.3). |

**Narrow test runs** (never run all tests): `pnpm --filter @oxagen/<pkg> test:unit <file>.test.ts`

**No `--` before the filename.** `pnpm --filter <pkg> test:unit -- <file>` does NOT
narrow the run — it runs every test file in the package. pnpm forwards the
arguments to the script, so vitest receives `vitest run -- <file>`, and vitest's
CLI parser puts everything after `--` into a passthrough bucket rather than
treating it as a positional filter. Vitest then sees no filter and runs the lot.
Measured on `@oxagen/config`: with the `--`, 4 files; without it, 1. This form was
documented across this file, CLAUDE.md and every agent definition for months, so
agents obeying the never-run-all-tests rule were violating it and reading a green
result as compliance. `pnpm --filter <pkg> exec vitest run <path>` also works and
is unambiguous.

**Local verification policy:** CI runs builds, lint, typechecks, coverage, and test suites. On the shared machine, run at most one test file for code this task changed, in isolation. Do not run `pnpm gate`, `pnpm gate:full`, or a package-wide suite locally. Lightweight integrity checks and configured git hooks still apply. `CLAUDE.md` has the verification workflow.

**Affected-package caveat:** `pnpm gate` selects packages changed since `origin/main`. If `HEAD` equals `origin/main`, it may select no packages. An empty selection is not verification evidence. Inspect the actual CI jobs and their output.

**Release script flags**: `tsx tools/scripts/release.ts major --dry-run` (preview without writing), `--set X.Y.Z` (exact version), `--no-npm` / `--no-git` / `--no-notes` (skip individual steps), `--from <ref>` (regenerate notes for an existing tag).

## Key Patterns

- **Tenant scope**: every DB query inside a scoped capability runs inside `runInTenantScope({ orgId, workspaceId })` from `packages/tenancy`. Missing this causes a `TenantScopeError` at runtime. Use `withTenantDb((tx) => ...)` for scoped Postgres access; `withSystemDb` for cross-tenant/system queries. Raw `db()` is banned.
- **IAM default**: `defaultEffect: "deny"` unless explicitly set to `"allow"`. Admin-only capabilities should set `sensitivity: "high"` and `defaultRoles: { org: { Owner: "allow", Admin: "allow" } }`.
- **`noBillingGate: true`**: set on management/settings capabilities that don't consume AI credits.
- **Test reset**: use `clearHandlersForTests()`, `clearRegistryForTests()`, `clearBillingAdmissionGate()` in test `beforeEach`. All are exported from `packages/oxagen`.
- **Coverage ratchet**: thresholds only go up, capped at 90. Never reduce a threshold. Keep at least 2.5% headroom below actual coverage.
- **Lint**: zero warnings. `eslint-disable` requires inline comment explaining why.
- **LLM calls**: all LLM calls must go through `@oxagen/ai` (re-exports `streamText`/`generateText`/`generateObject`/`embed`). Never import directly from `ai`. The `@oxagen/ai` layer emits metering, duration tracking, surface tagging, and prompt hashing to ClickHouse. Use `modelIdOf()` for model resolution — never hard-code slugs.
- **`bootstrapEntitlementRuntime()`** must be called at startup of any new runtime that invokes capability-gated handlers; forgetting silently skips the entitlement gate.
- **The tool list is the largest thing a turn sends, and it is checked before the request goes out.** `assertToolListFitsProvider` (`packages/agent/src/runtime/tool-budget.ts`) refuses a turn whose tool count exceeds a provider's per-request cap — OpenAI's is 128 — with a message naming the model, the limit and the count, rather than letting the gateway refuse it with a provider-shaped error about a request nobody can inspect. `PROVIDER_TOOL_LIMITS` is keyed by model-id **prefix**, not exact id, so a new model on a capped provider inherits the cap; a provider absent from that table means *no cap this codebase has confirmed*, not *no cap*. Every turn also logs the tool count and estimated tokens, because the figure that started this (45,007 tokens across 271 tools, 92.4% of the cacheable prefix) took a manual measurement to establish, and a number nobody can see is a number nobody manages (#2611).

## Local Development

**Docker via Colima** (macOS): `colima start` before `pnpm dev`. The Docker socket is at `~/.colima/default/docker.sock`. If `docker ps` fails with "Cannot connect to the Docker daemon", restart Colima: `colima stop && colima start`.

**Docker services** (`docker-compose.dev.yml`): Postgres 16 (`:5433`, user/pass `oxagen`/`oxagen`), Neo4j 5.24 (`:7474` UI, `:7687` Bolt`, pass `oxagen-dev`), ClickHouse 24.8 (`:8123` HTTP, `:9000` native`). Host port 5433 avoids collision with a system Postgres on 5432.

**Migration targeting**: `tsx --env-file=.env.local` does NOT override a shell-exported `DATABASE_URL`. Always `unset DATABASE_URL` before targeting local vs prod. Migration files go in `packages/database/atlas/migrations/`, never in `apps/`. After editing migration files, regenerate the checksum: `atlas migrate hash --dir "file://atlas/migrations"` from the `packages/database` directory. Confirm the target host and database name before mutation. Do not print credentials.

**App ports**: `apps/app` → `:3000`, `apps/docs` → `:3300`, API → `:4000`, MCP → `:4100`.

**Login**: Email and password, plus configured social providers. Local development can bypass email verification through the explicit local-environment settings. New user → `/signup` → `/new-organization` → create org → `/{org}/{ws}` (Fleet) by default. An explicit destination can override this for CLI consent. `/{org}` is Organization. The workspace root `/{org}/{ws}` is Fleet; the other workspace pages are `runs/[run]`, `mandates/[mandate]`, `agents`, `tools`, `steering`, `spend` and `skills`. Read `apps/app/src/app/` and `apps/app/e2e/routes.ts` for current routes. Returning: `/login`.

## CI Config

`.github/workflows/pipeline.yml` jobs: `preflight` (runs on every trigger, and on a push to `main` skips the rest of this run when a later push already superseded it, so a merge burst cannot queue full runs without bound — `check-main-preflight.mjs`); `atlas-validate`; `checks` (lint + typecheck, then `check:manifest` / `check:contracts` / `env:check` / `db:lint-migrations` / `check:db-migrate-script`, `check:audit-coverage`, `check:ui-parity --strict`, and `check:manifest:tickets`, which still files Linear tickets for parity gaps — a no-op today because the key is revoked; #2980 moves it and the nightly's `e2e:failure-ticket` to GitHub issues); `test` (migrate Postgres/ClickHouse/Neo4j, seed, build, unit tests, coverage thresholds); `e2e`; `rls-integration`; `rds-compatibility`; then `deploy-web` and `deploy-node` on `main`. `migration-gate` runs between them on a push to `main`: it applies pending Postgres, ClickHouse and Neo4j migrations, re-checks all three, and `deploy-node` waits on it (SCR-006, #3653). `deploy-web` is deliberately ungated — it publishes static HTML and opens no database connection. `publish-installers` runs after `deploy-node` and dispatches `desktop.yml`, which builds the desktop app for all four targets at the deployed commit as `X.Y.(Z+1)-N` and publishes it to downloads.oxagen.sh, moving the version-free `latest/` links the enrollment screens and docs use (ADR-158). `pnpm gate` mirrors the checks and test jobs. Other workflows: `migration-label.yml` labels a schema-changing PR `migration-required` (SCR-006); `vision-gate.yml` LLM-judges the PR diff against `docs/VISION.md` (advisory); `dod-check.yml` / `dod-close-guard.yml` / `dod-recheck.yml` enforce SCR-003; `triage-guard.yml` strips creator-applied priorities (SCR-005), except the P0 that `deployment-failure.yml` puts on the issue it files when a `main` run goes red or a deploy fails; `cancel-closed-pr-runs.yml` cancels a PR's CI runs when it merges or closes, so dead runs stop holding the runners the deploying `main` run waits for; `scr-corpus-check.yml` fails if any of the five org repos still carries `docs/scr/` (ADR-137); `nightly.yml`, `release.yml`, `linear-release.yml` (release notes to Linear, unrelated to issue tracking), `infra*.yml`, `store-migrate.yml`, `where-is-production.yml` are operational. CI runs inside `ghcr.io/macanderson/oxagen-ci-*` containers with Atlas baked in.

Production Postgres changes run through `infra/tools/run-db-migrations.sh`. Its dry run reports pending migrations. With `--apply`, it applies Atlas migrations and then runs the bundled `seedPlatform()` entry and seed assets in a Node container on the app node. A failed seed fails the operation; rerunning is idempotent. The RDS compatibility job verifies the same artifact against a fresh database without superuser privileges.

**Concurrency**: a push to `main` gets its own group, keyed by commit; everything else groups by ref so a new push supersedes the run before it. GitHub keeps one *queued* run per group, so a shared group means a third merge evicts the second before it starts — and when merges outpace the run, that chain never terminates. Nothing finishes, `deploy-web`/`deploy-node` never run because they need a passing check, and cancelled runs read as ordinary cleanup so nothing goes red. That took out eight deploys on 2026-09-07 (#2730). ADR-046 has the reasoning and what it costs; `tools/scripts/check-main-concurrency.mjs` fails `check:contracts` if the expression loses `github.sha`, because reverting it would look like a tidy-up.

**Pre-commit hooks** (lefthook): Biome format (staged files), ESLint fix (staged files), staged-file typecheck via `tools/scripts/typecheck-staged.mjs`, atlas-validate (only when migration files are staged). **Pre-push hooks**: `check:prose` for changes under `apps/web` or `apps/docs`, `check:contracts` + `env:check` for matched source files, plus `check:messages` when `apps/app`'s catalogues or sources change and `check:contextgraph-fixtures` when the CGP fixtures change. Test suites run in CI. `check:messages` regenerates nothing; it fails when `apps/app/src/i18n/messages.d.ts` is stale against `messages/*.json`, which is the one way a key the catalogue plainly holds becomes a `NamespacedMessageKeys` type error. Run `pnpm --filter @oxagen/app gen:messages` and commit the result.

## Git Workflow

`main` is shared and contested — never commit or push to it directly. Cut a branch from a fresh, synced `main`, push it immediately, commit and push frequently, and open a PR against `main`. Tests run in CI on every push/PR, not in git hooks. Full workflow: [`CONTRIBUTING.md`](CONTRIBUTING.md).

**Residue merges; it does not iterate.** A PR whose checks are green and whose only remaining review findings are **P2 or below merges now.** Every outstanding finding at P2 or below is carried into a residue issue, titled to the standard in `CLAUDE.md` under Issue titles with a trailing `(residue #<PR>)`, and the threads are resolved with a comment naming it. **One issue per PR is the default; never one per comment.** Split into more than one only where the findings cannot honestly share an issue — this repo requires exactly one `kind:` and one `job:` per issue and one full change per DoD (SCR-003), so residue spanning genuinely unrelated changes needs an issue each. Findings belonging to the same change stay together however many there are. From a reviewer's fourth round the round rule below extends this to a P1.

- **P0 and P1 never merge as residue.** They are fixed on the branch, or the PR waits. A P1 is the line: if one is open, the PR is not done. The round rule below is the one exception, and it opens only at a reviewer's fourth round.
- **The severity is the reviewer's, not the author's.** Take the badge the review left. A finding with no severity is judged by the same bar, and the ticket says which was assigned and why.
- **A residue ticket is a real handoff, not a receipt** — the finding verbatim, file path and line, why it is worth fixing, the pillar it moves, and a `- [ ]` DoD, to the same standard as any other issue here. Apply only the `triage` label (SCR-005).
- **Resolving the thread is an acceptance, not a dismissal.** The comment says the finding stands and where it now lives.

**Three rounds, then the rest is carried (round rule).** A reviewer that posts on every push can always find one more thing, so the rounds are counted and the count is bounded. Fix the findings of a reviewer's first three rounds on the branch. From its fourth round on, carry every remaining finding at P1 or below into that PR's residue issue and let the PR proceed, to the same standard a P2 already gets: the finding verbatim with its path and line, a `- [ ]` DoD, and a reply on the thread saying the finding stands and where it now lives.

- **A P0 blocks at every round.** No count retires a P0. A fourth-round P0 is fixed on the branch, or the PR waits.
- **A round is one submitted review, not one comment.** A review that posts nine findings is one round, counted per reviewer, so a reviewer that arrives late starts at its own first round.
- **Carrying a P1 is a decision you record.** The residue issue names the round that carried it and says it was deferred under this rule.
- **The count does not license a worse fix.** A finding you can fix correctly in the fourth round is still better fixed than filed.
- **Why three.** An automated reviewer reports on each push, so a PR that fixes everything it is told generates new findings by fixing them, and a green, tested change can sit behind cosmetic notes while production carries the defects it fixes. Mac set this bound on 2026-09-19, at three rounds, replacing a first draft of two.

**This rule is repo-local.** SCR-004 still requires fixing findings that can ride the PR. The severity and round rules above define the exception at merge time. This file owns those rules, and `CLAUDE.md` imports them. The standing-decisions block below is the record of those decisions in this repository (ADR-181). Connected repositories are steered from the workspace. They do not carry a copy.

**Review main integrations for lost fixes (#3237, ADR-110).** A clean three-way squash merge normally preserves changes made only on `main`. In the #3222/#3178 incident, the PR branch had already merged the fix from `main`, but that integration commit discarded the CLI exemption. The squash then landed the damaged branch. Before merging, integrate current `main`, review the resolutions, and check the behavior both sides changed. `pipeline.yml` runs `tools/scripts/check-stale-merge-base.mjs` as an advisory overlap scan for branches behind `main`. Its exact-line signals can include formatting, and an up-to-date result does not inspect earlier integrations. Requiring up-to-date branches remains a maintainer setting decision. It cannot prevent a bad integration resolution. The historical audit and retained evidence are linked from ADR-110. Separately, `pnpm check:contracts` asserts that `packages/iam/src/machine-key-scope.ts` branches on every scope purpose value a live key can carry.

## Documentation

| Path | Content |
|---|---|
| `README.md` | Product framing, monorepo layout, getting started, the gate, AWS deployment |
| `docs/VISION.md` | Positioning and drift tests the Vision Gate judges against |
| `docs/capabilities/_index.md` | Index of capability doc files (one `<dotted-stem>.md` per contract) |
| `docs/adr/` | Architecture Decision Records (ADR-043 runtime excision, ADR-042 data planes, ADR-046 CI concurrency, …) |
| `docs/specs/` | Specs: `tacho/`, `adr025-naming-mapping.md`, and per-feature designs |
| `CONTRIBUTING.md` | Branch / PR workflow and the capability-parity checklist |
| `DEREGISTERED.md` | The register of features taken off the surfaces whose code stays in the tree — what is unreachable, where its code is, and what replaced it |
| `CLAUDE.md` | Engineering operating rules (prime directive, test gate, CI policy) |

Use tracked source paths for code navigation. `.agents/skills` is a symlink to `.claude/skills`; the former generated `.agents/summary/` maps are gone.

## Custom Instructions

<!-- This section is for human and agent-maintained operational knowledge.
     Add repo-specific conventions, gotchas, and workflow rules here.
     This section is preserved exactly as-is when re-running codebase-summary. -->

### Writing: `clear-prose` is required

Load the `clear-prose` skill (`.claude/skills/clear-prose/SKILL.md`) before you write or edit any prose a person will read, internal or external. That covers pages, docs, blog posts, emails, READMEs, changelogs, ADRs, specs, SCRs, issue and PR bodies, review comments, code comments, commit messages, UI strings, error messages, and CLI output. Stella reads this file directly, so the rule binds both agents.

- **Internal text is not exempt.** An ADR, an issue handoff, or a PR description is read by a person who has to act on it, and the same rules make it faster to act on.
- **It pairs with `oxagen-branding`.** Branding owns positioning, vocabulary, and the visual system. `clear-prose` owns the sentences. Customer-facing copy needs both.
- **Check before you ship.** `pnpm check:prose` scans `apps/web` and `apps/docs` and fails on em dashes, exclamation points, and the avoid list. Text outside those two apps has no scanner, so read it once against the skill's "Before shipping" questions.

### UI Component Import Convention

**Never import `@oxagen/ui/components/*` directly in app code.** Each app imports UI through its own local layer, and which layer that is differs per app. (`apps/admin` and `apps/website` do not exist in this monorepo — the 6 apps are `api`, `app`, `cli`, `docs`, `mcp`, `web`.)

- **`apps/app`** — `@/ui/<name>`, backed by `apps/app/src/ui/`. These are original components, not re-exports; the app imports no `@oxagen/ui/components/*` and has **no** `src/components/` directory. It carries its own ESLint 10 config.
- **`apps/docs`, `apps/app_deprecated`** — `@/components/ui/<name>`, a genuine re-export layer over `@oxagen/ui/components/*`, enforced by `eslint.next.mjs`.

```ts
// ✅ Correct — uses the app's re-export layer
import { Button } from "@/ui/button";           // apps/app
import { Button } from "@/components/ui/button"; // apps/docs, app_deprecated

// ❌ Forbidden — bypasses the indirection
import { Button } from "@oxagen/ui/components/button";
```

**Why:** The re-export layer is a cheap override escape hatch. If a shared component ever needs an app-specific wrapper (e.g. injecting Next.js `Link`, adding a context provider), you swap the one-liner in `src/components/ui/button.tsx` for a local wrapper — zero consumers change. Direct imports bypass this.

**Exceptions:** The re-export files themselves (`src/components/ui/*.tsx`) legitimately import from `@oxagen/ui/components/*`. Importing `@oxagen/ui` (barrel), `@oxagen/ui/styles/*`, and `@oxagen/ui/lib/*` is allowed everywhere.

**Enforcement:** `no-restricted-imports` in `eslint.next.mjs` — errors on any `@oxagen/ui/components/*` import outside the `src/components/ui/` layer. Its first line names its scope: `apps/app_deprecated` and `apps/docs`.

**`apps/app` is not enforced.** Its standalone `apps/app/eslint.config.mjs` restricts the tenancy seams, the `next/navigation` names INV-13 routes, and cross-lane `@/features/*/*` imports — and nothing else. There is no `@oxagen/ui/components/*` pattern in it, so a direct shared-component import there lints clean. The rule holds in `apps/app` because the app has its own components and imports that path zero times, not because anything refuses it. Treat it as a convention there until a rule and its `src/test/arch/probes/lint` probe exist.

### UI Component Test Placement

Tests for shared components (`@oxagen/ui`) live in `packages/ui/src/components/<name>.test.tsx`. Tests for `apps/app`'s own components sit beside them in `apps/app/src/ui/` (e.g. `avatar.test.tsx` next to `avatar.tsx`).

**Rule of thumb:** if the component's source is a re-export (`export * from "@oxagen/ui/components/..."`) → the test belongs in `packages/ui`. If the component is an original implementation that lives only in the app → the test stays in the app.

### Design Token Usage in Shell Components

Shell chrome in `apps/app/src/features/shell/` must use the component-level design tokens from the house styles rather than generic base tokens. Read `apps/app/src/app/globals.css` and `packages/ui/src/styles/globals.css` for the imported styles and token definitions.

| Area | Use these tokens | Not these |
|---|---|---|
| Content panel | `bg-app-panel-bg`, `text-app-panel-fg` | `bg-background`, `text-foreground` |
| Drawers, flyout, phone-bar count pills | `bg-app-raised-bg`, `text-app-raised-fg` | `bg-card`, `bg-app-panel-bg` |
| Topbar / header | `bg-app-topbar-bg`, `text-app-topbar-fg`, `border-app-topbar-border` | `bg-background`, `border-border` |
| App chrome links | `text-app-link-fg`, `hover:text-app-link-hover-fg`, `text-app-link-active-fg` | `text-muted-foreground`, `text-foreground` |
| Sidebar surface | `bg-sidebar-bg`, `text-sidebar-fg` | `bg-sidebar`, `text-sidebar-foreground` |
| Sidebar nav items | `text-sidebar-nav-link-fg`, `hover:bg-sidebar-nav-link-hover-bg`, etc. | `text-sidebar-foreground`, `hover:bg-sidebar-accent` |
| Sidebar group labels | `text-sidebar-nav-label-fg` | `text-muted-foreground` |

**Why:** Component tokens are the reskin knobs. A designer changes `--app-topbar-bg` once in `globals.css` and every header in every shell file re-skins. Using generic tokens (`bg-background`) defeats this — you'd have to touch every component file.

---

## Harnesses

Four harnesses are first-class here: Claude Code, Codex, Cursor and Stella (ADR-101). Whichever one you are, read both `AGENTS.md` and `CLAUDE.md` before you change anything. `CLAUDE.md` holds the prime directive, the git workflow, the no-local-verification rule, the test gate, and the issue rules, and they bind every agent in this repository, not only Claude Code.

- Skills live in `.claude/skills/`. `.agents/skills` is a symlink to it for Codex, and Cursor and Stella read or adopt `.claude/` directly.
- Anything Oxagen exports for an agent (a skill, an agent definition, a rule, an MCP entry, a hook) must load in all four harnesses. ADR-101 has the table of where each harness reads each artifact.

## Standing decisions — apply without asking

This block is the record of each standing decision in this repository. The
repository carries no `.oxagen/` directory (ADR-181). A workspace linked to
it holds the same decisions as context records and steers every connected
repository from them. A connected repository does not carry a copy.

- **SCR-001 — Tests/builds
  (inner loop):** Never compile or run the full test suite while developing.
  Build and test only the crates/packages/modules touched by the change
  (plus direct dependents on interface changes). The full suite is CI's job.
  Here: `pnpm --filter <package> test:unit <file>.test.ts`, never bare `pnpm test`
  or `turbo run test:unit`. **Not `... test`**: no workspace package defines a
  `test` script, so `pnpm --filter <package> test` exits 0 having run nothing at
  all. Only the repo root defines one, and it is `turbo run test:unit`, the full
  suite this rule exists to keep out of the inner loop.
- **SCR-002 —
  Architecture decisions:** Do not ask. Choose the most durable option — the
  one that can't be questioned in 10 years as the right move. Cheap-and-easy
  only wins when it is also the excellent durable choice. Record every such
  decision as an ADR in `docs/adr/`; the ADR replaces the question.
- **SCR-003 — Definition of
  done:** An issue closes only when every DoD checklist item is satisfied
  and verified. Reference-grade includes tests, code comments, docs, and
  CI — not just the implementation. A PR that advances an issue without
  finishing it links it with `Refs #N` rather than `Closes #N`: `Refs`
  does not close, so the merge gate does not hold that PR against the
  issue's DoD. A PR may carry both, and is gated only on what it closes. A
  PR that closes nothing is waived by a label, and which one is a claim:
  `no-issue` for a trivial change, `closes-nothing` for a substantial one
  that closes no issue by design.
- **SCR-004 — Fix over
  file:** Fix what you notice in the PR you are making; two unrelated fixes
  in one PR is fine. File an issue only when a fix cannot responsibly ride
  the PR (a maintainer decision, a rig or spend, or work larger than the
  session), and only when fixing it moves stability, reliability,
  maintainability, innovation, efficiency, or performance. Apply ONLY the
  `triage` label. One issue carries one full change as a DoD checklist —
  no sub-issues, parents or epics; the tracker is GitHub issues and the
  label scheme is in CLAUDE.md "Issues and labels".
- **SCR-005 — Triage
  separation of duties:** Never apply priority (`P0`–`P4`), size or the
  descriptive `kind:` / `area:` / `job:` / `pillar:` / `needs:` labels — the
  triage identity owns them; a guard workflow strips creator-applied
  priorities.
- **SCR-006 — Schema
  changes and migrations:** A pull request that changes a schema carries
  `migration-required`, and the migration reaches production before or with
  the deploy of that change, never after. Here the label is applied from the
  diff by `.github/workflows/migration-label.yml` and comes back if removed,
  and `migration-gate` in `pipeline.yml` holds the deploy until the stores
  carry the schema. `migration-gate` also applies the pending migrations on
  merge (decided 2026-09-23, #3653), so the label is the only thing a
  schema-changing PR adds. Write no apply steps and apply nothing by hand.

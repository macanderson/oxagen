# Contributing

Oxagen is workforce management for autonomous agents, on the shared agent control plane their operators work in (ADR-113): every agent has its own identity and operates under a mandate — its access, its budget, its tools and skills, its rules — set by the teams accountable for it and enforced on the actions routed through Oxagen. It is sold to those teams. Every contribution is judged against that vision — read [`docs/VISION.md`](docs/VISION.md) before proposing a feature. CI runs a **Vision Gate** (`pnpm check:vision`) that LLM-judges every PR diff against it; routine fixes, tests, and tooling are neutral by definition, but strategic drift gets flagged.

## Prerequisites

- Node.js 24.21.0 or later (`node -v`; `.node-version` holds the pin, so `nvm use` or `fnm use` picks it up)
- pnpm 12+ (`npm i -g pnpm`) — the repo pins `pnpm@12.6.0` via `packageManager`
- Docker (for local Postgres :5433, Neo4j :7687, ClickHouse :8123)

## First-Time Setup

```bash
cp .env.example .env.local   # fill in required values
pnpm install
pnpm env:check               # validate .env.local
pnpm dev                     # starts Docker + migrations + all apps
```

## Git Workflow — branch early, push often, open a PR

`main` is a shared, contested branch worked in parallel by multiple humans and coding agents. **Never commit or push directly to `main`.** Test suites run in CI on every push and PR (not in git hooks), so pushing is cheap — push early and often.

1. **Start from a fresh, synced `main`:** `git fetch origin`; if `origin/main` is ahead, `git switch main && git rebase origin/main` (resolve conflicts) before cutting your branch.
2. **Cut a branch and push it immediately:** `git switch -c <type>/<slug> && git push -u origin <type>/<slug>`. Use a `git worktree` for any large body of work: `git worktree add ~/Projects/.worktrees/oxagen/<slug> -b <branch>`.
3. **Commit frequently, push regularly.** Small increments at every meaningful step. A pushed work-in-progress branch beats a perfect change sitting on your disk.
4. **Open a PR against `main`** — a draft early on is fine. The PR is where CI runs the full gate and where the work gets reviewed and merged.
5. **Watch the PR until it merges.** Poll it every 60 seconds, fix each CI job the moment it fails, and resolve conflicts as they appear. `CLAUDE.md` under Pull request monitoring has the commands.

Other rules:

- Commit messages: imperative mood, under 72 chars (`Add capability: recall_memory`) — dotted capability names are retired (ADR-025).
- GitHub ignores negation. "This PR does not close #12" closes #12 on merge, so the `dod` check fails a PR whose body or commit messages carry that phrasing (#3680). Write `Refs #12`, or put the reference in backticks.
- Don't rebase, squash, or cherry-pick to "tidy" shared history — correct, complete, pushed work beats a pretty history.
- Everything committed must be **functionally complete**: fully wired end-to-end, every layer present, tests passing, no dead code.

## Before Marking a PR Ready

CI runs the build, lint, typecheck, coverage, and test gates. Do not run those suites on the shared development machine. The local exception is one test file for code the task changed or created, run in isolation. Lightweight source, link, contract, and prose checks still apply.

Push the final commit and inspect `gh pr checks`. Report pending checks as pending. See `CLAUDE.md` for verification artifacts and the local execution policy.

### Stale merge base (#3237)

Before merging, integrate current `main` and review every resolution for behavior lost from either side. A clean squash normally preserves changes made only on `main`. The #3222/#3178 loss was already present in the PR branch's integration commit. See [ADR-110](docs/adr/ADR-110-a-squash-merge-can-silently-revert-an-older-branch-wins-fix.md).

The advisory `tools/scripts/check-stale-merge-base.mjs` reports overlapping exact-line differences when a branch is behind `main`. Inspect the merged result for the behavior those lines carried. An up-to-date result does not check earlier integration resolutions.

Requiring up-to-date branches remains a maintainer ruleset decision. It does not prevent a bad integration resolution.

Separately, `pnpm check:contracts` asserts that `packages/iam/src/machine-key-scope.ts` (the file the 2026-09-17 incident actually broke) branches on every scope `purpose` value a live API key can carry, so that file cannot lose a purpose branch again regardless of how it happens.

## Adding a Feature

### New Capability

Every user-facing action is a **capability**: a typed contract exposed with parity across API, MCP, CLI, and UI. The correct order is always contract → API route → MCP tool → UI/CLI wire-up — never wire a UI surface to live data before the contract exists.

1. Define the contract in `packages/oxagen/src/contracts/<name>.ts`
2. Add the barrel import to `packages/oxagen/src/contracts/index.ts` — note `tools/scripts/check_manifest.mjs` also auto-generates `contracts.generated.ts` from the contracts directory, but the hand-maintained `index.ts` barrel remains the authoritative one consumed by the rest of the codebase
3. Implement the handler in `packages/handlers/src/<name>.ts`
4. Register it in `packages/handlers/src/register.ts`
5. Add the API route in `apps/api/src/routes/v1/<capability>.ts`
6. If exposing on MCP: add `apps/mcp/src/tools/<name>.ts`
7. If exposing on CLI: add `apps/cli/src/commands/<name>.ts`
8. Add the capability doc in `docs/capabilities/<name>.md` and update `_index.md`
9. Write unit tests — coverage must meet the package threshold
10. Run `pnpm check:manifest` to verify parity

Contract fields that require careful thought:

- `defaultEffect`: use `"deny"` for most capabilities; `"allow"` only for truly public reads
- `sensitivity`: drives IAM audit logging and default grant decisions
- `noBillingGate`: set to `true` for management/settings ops that don't consume AI credits
- `defaultRoles`: seed IAM grants — these become the defaults in `seed-iam-defaults.ts`

Vision-alignment requirements for every new capability:

- **Metered** — it dispatches through `invoke()` so usage events land in ClickHouse. No unmetered side doors.
- **Governed** — IAM + entitlement gates apply; no `"just this once"` untyped/ungated paths.
- **Grounded** — if it surfaces agent output where graph grounding applies, the output cites nodes/edges (resolve authorized human labels server-side and keep raw identifiers in inspectable details).
- **Vendor-neutral** — model access through `@oxagen/ai` and `modelIdOf()`; never import `generateText`/`streamText`/`generateObject` directly from `ai` in a handler or route, and never hard-code a model slug.

### New Postgres Schema

Schemas go in `packages/database/src/schema/`. Use the existing `pgSchema()` pattern:

```typescript
import { someSchema } from "./_schemas";
export const myTable = someSchema.table("my_table", { ... });
```

Create the migration:

```bash
pnpm db:migrate:diff     # generates Atlas migration file
pnpm db:lint-migrations  # verify integrity
pnpm db:migrate          # apply locally
```

Never create migration files manually — always use `atlas migrate diff`. Migration files go in `packages/database/atlas/migrations/`, never in `apps/`.

**A migration may not require a superuser.** Production runs on Aurora, where the connecting role gets `rds_superuser` — which creates roles, databases and allowlisted extensions, but is **not** a Postgres superuser and can never be granted `BYPASSRLS`. Postgres gates some statements on the actor holding the real superuser bit whatever the values involved, so these fail `42501` on Aurora while passing on a local container:

| Don't write | Because | Instead |
| --- | --- | --- |
| `ALTER ROLE x NOSUPERUSER` / `NOBYPASSRLS` | gated on the *actor* being a superuser even when the value is unchanged | guard it on `pg_roles` so it is reached only when the role has actually drifted |
| `CREATE FUNCTION … SET my.custom_guc` | persisting a custom GUC on a signature needs the superuser bit (`SET search_path` is fine) | set it in the body with `set_config(…, true)` and restore the caller's prior value before every exit |
| anything assuming `BYPASSRLS` can be granted | Aurora grants it to no role, by any means | test `current_setting('app.rls_bypass', true) = 'on'` in the policy, as the existing tables do |

Both of the first two shipped and passed CI for months before Aurora rejected them (#1333). The `rds-compatibility` job now applies the whole directory from empty as a role with those limits, so it is caught on the pull request rather than on a real cluster — `tools/scripts/rds-sim-check.sh`. It does **not** check extension availability; that still needs a real cluster (#1341).

**Target check before any mutation script:** confirm the host and database name without printing credentials; local = `localhost:5433`. `tsx --env-file=.env.local` does **not** override a shell-exported `DATABASE_URL` — `unset DATABASE_URL` to force local targeting. **Verify with a `SELECT` after migration** — don't trust logs alone.

### New Inngest Function

Add to `packages/inngest-functions/src/functions/`. Register in `src/functions.ts`. Inngest functions must be idempotent — use `computeEventHash` for deduplication.

### New Connector

Add to `packages/ingestion/src/connectors/<name>/index.ts`. Implement:

- `verifyWebhook(req, secret)` — HMAC or connector-specific verification
- `normalizeRecord(raw)` — map raw API response to `NormalizedRecord`
- `previewRecordTypes()` — available record type definitions

Register in `packages/ingestion/src/connectors/types.ts`. Connectors dual-write: Postgres holds the operational record (sync cursor, connection health — source of truth), Neo4j holds the graph index (async via Inngest, retryable), ClickHouse observes ingestion telemetry.

## Testing Standards

- **New code requires new tests.** Handlers, utilities, routes — all need unit tests.
- **Coverage thresholds are ratchets** — only increase, capped at 90, never decrease.
- **E2E has exactly three specs:** `login`, `pay`, and `page-load` in `apps/app/e2e/`. Use component and action tests for other flows, following `apps/app/ARCHITECTURE.md` §6.3.
- **UI changes need runtime evidence:** a relevant component test or a screenshot of the working page. E2E retains traces on failure.
- Threshold headroom rule: bump only when `floor(new_coverage - 2.5) > current_threshold`.
- Run the **narrowest** command that proves your change (`pnpm --filter <pkg> test:unit <file>`), in isolation. Do not run a package-wide or repository-wide suite locally.

## Coding Standards

- **TypeScript strict mode** — no `any`, no `// @ts-ignore` without a comment
- **Zero ESLint warnings** — `eslint-disable` requires an inline justification comment
- **Zod for all external boundaries** — API inputs, env vars, capability contracts
- **Tenancy seam**: every DB query inside a scoped capability must run inside `runInTenantScope`; raw `db()` is banned — use `withTenantDb` / `withSystemDb` / `scopedSession`
- **All LLM calls through `@oxagen/ai`** — never import the `ai` SDK directly in handlers or routes; the re-exports emit metering, duration tracking, and prompt hashing to ClickHouse
- **No cross-domain FKs inside schema builders** — use Drizzle relations in `src/relations.ts`
- **Storage boundaries are hard law**: Postgres = transactional state, Neo4j = graph, ClickHouse = append-only events, blob storage = binaries. See `AGENTS.md` and `docs/adr/`.
- **UI imports**: use `@/ui/<name>` in `apps/app`. Its components are original implementations. Use `@/components/ui/<name>` in `apps/docs` and `apps/app_deprecated`, where ESLint enforces the re-export layer. Do not import `@oxagen/ui/components/*` directly in app code.
- **Never display raw node/edge UUIDs in the UI** — cite by human label with an inspectable popover.

## Dependency Management

- Add deps to the specific `package.json` that imports them, not the monorepo root
- Run `pnpm i --no-frozen-lockfile` after any dep change to sync the lockfile
- Use exact or tightly pinned versions for new dependencies
- Check `pnpm-workspace.yaml` overrides before adding a dep that may conflict
- Vendor neutrality is a moat: prefer neutral abstractions over vendor-specific SDKs wherever one exists

## Environment Variables

All env vars must be declared in `packages/config/src/registry.ts` with Zod validation. After adding a new var:

1. Add to `packages/config/src/registry.ts`
2. Add to `.env.example`
3. Run `pnpm env:check` to verify

Keep production URLs isolated to env vars — never hard-code domains.

## Release Process

Only for maintainers. There are two ways to cut a release and one way to try
a build. They write the same version into every tracked manifest in the tree,
whatever its language (`package.json`, `Cargo.toml`, `Cargo.lock`);
`pnpm check:versions` holds them in lockstep in CI and `--fix` writes them.

### From GitHub, the usual way

Actions, Release, Run workflow, then pick `patch`, `minor` or `major`. That run:

1. bumps every manifest to the next version and has a model write the release
   notes from the diff since the last tag, under the `clear-prose` and
   `oxagen-branding` skills, checked by `check:prose`;
2. writes `releases/v<version>.md`, the top of `CHANGELOG.md`, and the docs
   page `apps/docs/content/docs/releases/v<version>.mdx`;
3. opens a pull request titled `chore(release): v<version>` with auto-merge
   on. Read the notes there; edit the docs page on that branch if a line is
   wrong. CI gates the PR like any other.

When the PR merges, the `tag` job tags `v<version>` and `desktop-v<version>`,
opens the GitHub release with the notes, publishes `@oxagen/cli` to npm, and
the `desktop-v` tag starts `.github/workflows/desktop.yml`, which builds the
app on four runners and publishes the installers, their checksums and the
listing page to https://downloads.oxagen.sh/. The docs page is live at
https://docs.oxagen.sh/docs/releases/v<version> once main deploys.

The workflow needs the `RELEASE_TOKEN` secret: a fine-grained personal
access token for this repository with contents, pull requests and workflows
set to write. The workflow's own token cannot open a PR that CI runs on.
`dry_run: true` previews the version and the notes without it.

### From a laptop, when you want to watch it land

```bash
pnpm release:patch:publish      # 2.1.1 -> 2.1.2, then build every platform in CI and upload
pnpm release:minor:publish      # 2.1.1 -> 2.2.0
pnpm release:major:publish      # 2.1.1 -> 3.0.0
```

`release:<bump>:publish` (`tools/scripts/release-publish.ts`) diffs the notes
from the last published GitHub release rather than the newest tag, so a tag
that never shipped is not a release boundary, and ends them with a link to
every installer and executable of the version by its published name. It then
commits on `release/vX.Y.Z`, tags `vX.Y.Z` and `desktop-vX.Y.Z`, opens the
pull request, waits for `desktop.yml` to build the four targets, uploads the
installers to downloads.oxagen.sh and `@oxagen/cli` to npm, checks that every
file the notes link to is on the GitHub release, and publishes it.

The uploads are the same ones `desktop.yml` does on the tag, so on a healthy
run this reports them already done. Every step skips a version that is
already on downloads.oxagen.sh, on npm, or published on GitHub, which is what
makes it safe beside the Release workflow and what lets an interrupted run
resume with `--publish-only`. `--dry-run` previews the version and the notes.

### A build with no release

```bash
pnpm dist:local                 # tacho, oxagen, and the desktop app from this tree; the installer lands on ~/Desktop
pnpm dist:local --out /tmp/x    # somewhere else
```

`dist:local` builds what is on your machine, for your OS and architecture
only (the sidecars embed the running `node` and are not cross-compiled),
signed with the updater key when `~/.tauri/oxagen-desktop.key` is present. It
bumps nothing and uploads nothing. It is the way to try an installer before a
release.

`pnpm release:<bump>` alone (`tools/scripts/release.ts`) is the bump, the
notes, and a local commit and tag, with no CI wait and no uploads:

```bash
tsx tools/scripts/release.ts patch --dry-run   # the bump and the notes, nothing written
pnpm release:patch                             # bump, notes, commit and tag on your branch
```

See the header of each script for its flags.

## Security

Never open a public issue for a vulnerability — see [`SECURITY.md`](SECURITY.md) for private reporting channels.

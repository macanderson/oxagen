# CLAUDE.md

## Prime directive — fix every issue you encounter, no matter what

When you encounter a bug, broken path, dead value, mispriced meter, stale
config, or any defect — **fix it now, in place, completely.** Do not defer it,
ticket-and-skip it, footnote it as "cosmetic / out of scope," or hand the user a
follow-up. If you noticed it, you own it this turn. The user cannot track
deferred work and has explicitly forbidden it. The only acceptable surface for a
"later" is a *true external action* you cannot perform from here (e.g. flipping a
prod env var) — and even then you fix everything in code first. Investigate to
root cause, fix every co-located instance of the same class of bug (not just the
one that was reported), and verify with tests/typecheck before declaring done.

## Operating mode — build fast, no customers are live

This repo is in **pre-launch build mode, NOT pull-request mode.** There are no
live customers and no production traffic to protect.

- **Commit and push directly to `main`.** You do not need to open PRs or wait for
  review. However, **run the full CI gate locally before pushing** — do not rely
  on CI to catch failures. The `pnpm gate` command runs lint, typecheck, coverage,
  tests, and migrations. All must pass locally before any push to main.
- **Dangerous, breaking edits are allowed**, including changes that would break
  production, drop/rewrite schemas, or remove APIs. Move fast; don't tiptoe.
- The one non-negotiable: **everything you ship must be round and complete from a
  functionality perspective** — fully wired end-to-end, every layer present (no
  half-built features, no `dall-e-3`-style placeholders left charging $0), tests
  passing, no dead code. "Fast and breaking" is licence on *process and blast
  radius*, never on *completeness*. Pair this with the prime directive above.

## Test gate enforcement — non-negotiable

Every code change that ships must leave the package's test suite **at or above the
coverage gate defined in that package's `vitest.config.ts`** (`coverage.thresholds`).

Rules:
- **New code requires new tests.** Route handlers, contracts, utilities — all new
  source files need corresponding tests before the commit lands. No exceptions.
- **E2E parity.** Any user-facing flow added or changed must have an e2e test in
  the affected app's test suite (Playwright in `apps/app/__tests__/`). If the e2e
  suite doesn't yet exist for that flow, create it.
- **Coverage thresholds are ratchets — never lower them.** Each `vitest.config.ts`
  `thresholds` block is a floor. When you ship new tested code that raises the
  measured coverage, bump the threshold to match (round down to the nearest integer
  percentage). Never reduce a threshold; it records the highest bar we've cleared.
- **Run the full CI gate before opening any PR.** Before opening a PR, run the
  complete CI pipeline locally via `pnpm gate` to verify lint, typecheck, coverage,
  tests, builds, and migrations all pass. Do not open a PR with failing or unknown
  CI status. This is non-negotiable: PRs with broken CI waste review time and block
  the pipeline. If you cannot run `pnpm gate` locally (e.g., due to environment
  constraints), explicitly note this in the PR and explain what was verified instead.
- **Verify locally before pushing to main.** Run `pnpm test:coverage` (unit) and
  `pnpm test:e2e` (e2e, if applicable) from the affected package before `git push`.
  Do not rely on CI to catch a coverage regression — fix it before it lands on
  `main`.
- **Lint is part of the gate.** The `--max-warnings 0` flag is enforced for every
  package. Zero ESLint warnings means zero; suppress nothing with `eslint-disable`
  unless the rule is genuinely inapplicable (add an inline comment explaining why).
  If you introduce code that triggers a new warning, fix the root cause rather than
  suppressing.

## Completion with evidence — verification discipline

**Never claim a task is complete, a fix works, or a deploy succeeded without
concrete verification.** Always provide evidence: test output, CI status, deployed
artifact state, or rendered result. "It works" claims without proof have wasted
countless rounds of correction and should never be accepted.

Rules for completion:
- **No task is done until verified.** Always run the relevant test suite, E2E
  tests, or integration checks before declaring completion. State explicitly what
  verification you ran and its output.
- **UI changes require screenshots as evidence.** For any user-facing UI change,
  capture a screenshot showing the feature working correctly, forms submitting
  without error, and the page being navigable and usable. Screenshots are not
  optional — they are the proof that "it works" is real.
  - E2E tests must capture screenshots of key success states (form submitted,
    data loaded, navigation working). The screenshot directory must be deleted
    and recreated on every test run (not accumulated across runs).
  - Add the screenshot directory to `.gitignore` so they don't pollute the repo.
  - Example: `apps/app/__tests__/screenshots/` in `.gitignore`.
- **Forms must be tested end-to-end without error.** Any form added or changed
  must have an E2E test that submits data and verifies success. If the form
  saves to a database, query the database to confirm the save succeeded. If it
  calls an API, verify the API response. Do not accept "form works" without this
  proof.
- **Deployments must be verified in the target environment.** After deploying, run
  a health check, query the database, or hit a relevant API endpoint to confirm
  the deploy actually landed and is working. Do not trust deploy logs alone.
- **Database changes must be verified with queries.** After a migration or data
  change, run a `SELECT` query to confirm the change is actually in the database,
  not just in logs or code.

## Working with this user

The user routinely sends **multi-part prompts** — a single message asks for
several only-loosely-related things in one shot. When you read one and find
≥2 logically independent units of work, decompose immediately and dispatch
subagents in parallel for the independent pieces. Never serialize work
that has no dependency chain — it wastes the user's time and the user has
explicitly asked for this pattern.

**Delegate by default.** When you've identified work, your first move is
to dispatch agents for it, not to start executing it yourself in a long
sequence of tool calls. Grinding through a queue of tasks personally is
the *failure mode* the user has explicitly called out. Pattern:

1. Parse the user's request and decompose into independent units.
2. For each unit, decide: is this a single 1-2 line edit OR a multi-step
   chunk? If multi-step, dispatch an agent. If trivially small, batch
   into a single parallel tool-call block, do NOT serialize.
3. Send the dispatches in **one message** with multiple Agent calls.
4. Use the agents' results to inform your response; don't re-do their
   work in the parent context.

The only time to keep work in the parent context is when later steps
depend on earlier ones AND each step is small. Otherwise delegate.

The decomposition rule of thumb:

- Research / investigation → dispatch an agent (good context isolation)
- File edits in known locations → do yourself in parallel tool calls
- Codebase mapping or breadth search → dispatch `Explore` agent
- Anything that touches a different repo/system → its own agent

Examples of independence:
- "Fix X, document Y, ask about Z" — three agents, send in one message
- "Update the spec and create the tickets" — sequential (tickets reference the spec)

## Project skills

This repo ships its own Claude skills under `.agents/skills/`, auto-registered
via symlinks in `.claude/skills/`. They are the canonical, agent-facing layer —
there is no separate `docs/agents/` copy. Reach for them by name (the Skill tool
or fully-qualified `oxagen-engineering-policy` etc.); dispatched subagents inherit
them too, so name the relevant skill in an agent's prompt.

- **`oxagen-engineering-policy`** — **binding law.** The non-negotiables, prime
  directives, four-store data model, SQL conventions, bloat/vendor/naming rules,
  observability, PR discipline. **Consult it BEFORE writing or changing code,
  picking/pinning a dep, designing a schema or migration, writing tests, opening
  a PR, or touching CI.** When a request conflicts with it, halt and surface the
  conflict — do not weaken the rule. This supersedes nothing below; it is the
  floor everything else sits on.
- **`oxagen-design-system`** — Oxagen's brand & visual identity (palette, the
  indigo→green gradient ring, Aeonik type, motion tokens, glass/card treatment,
  iconography, voice & casing). Use for any user-facing UI or product copy in
  `apps/app` so output reads as Oxagen.
- **`coss-ui`** — the coss ui (Base UI) component system as implemented by
  `@oxagen/ui`: registry & import paths, `render`-not-`asChild` composition,
  `*Popup`/`*Panel`/`Menu*`/`TabsTab` naming, size scales & semantic tokens, and
  the shadcn/Radix → coss migration mapping. Use when building, restyling, or
  reviewing UI that imports `@oxagen/ui` (`@/components/ui/*`), or migrating
  shadcn/Radix components to coss/Base UI.
- **`frontend-patterns`** — a 136-entry library of web-platform technique guides
  (CSS, a11y, Core Web Vitals, forms/autofill, passkeys, view transitions,
  scroll animation, privacy, security). Use when building/reviewing frontend:
  open the one or two matching technique files, don't read the whole library.
- **`reablocks`** — component/chart/graph library used in `apps/app`. Use when
  building or restyling data-rich UI: tables, timelines, block-based layouts.
- **`reagraph`** — graph-visualization layer (WebGL, force-directed). Use when
  rendering knowledge-graph, lineage, or topology views.
- **`reaviz`** — charting library (d3-backed). Use when building analytics charts,
  sparklines, or metric visualizations in the app.
- **`oxagen-feature`** — feature-development workflow skill. Use when scaffolding
  a new product feature end-to-end (contracts → routes → UI → tests).
- **`vendor-better-auth`** — documentation map (llms.txt index) for Better Auth.
  Use to jump to the right official doc; pair with the `*-best-practices` auth
  skills for hands-on setup.
- **`oxagen-code-audit`** — full-repo audit against the engineering law:
  fan-out auditors → adversarial verify → safe auto-fix in a worktree → Linear
  tickets for approvals → interactive HTML dashboard. Use when asked to "audit
  my code", "give me an audit report", or score package health.

Routing: code/schema/test/PR/CI → `oxagen-engineering-policy` first. Building UI →
`coss-ui` (component API) + `oxagen-design-system` (identity) + `frontend-patterns`
(technique) + `reablocks`/`reagraph`/`reaviz` (component libs as needed). Auth →
`vendor-better-auth` + the Better Auth `*-best-practices` skills. New features →
`oxagen-feature`. See `.agents/skills/README.md` for the full local-skill manifest.

## Production URLs (interim)

Until oxagen.ai is launched, production deploys use Vercel-managed domains:

- App: `https://oxagen-v2-app.vercel.app`
- API: `https://oxagen-v2-api.vercel.app` (Hono REST; no MCP protocol endpoint)
- MCP: `https://oxagen-v2-mcp.vercel.app` (xmcp server; connect at `/mcp` over
  streamable HTTP — **not** `oxagen-v2-api.../mcp/sse`. Org+workspace scope is
  carried by the API key, so no org/workspace path segment is needed.)
- Docs: `https://oxagen-v2-docs.vercel.app`

When generating OAuth callback URLs, env values, allowedOrigins, or any
docs/spec content that references prod URLs, use the vercel.app domains.
Switch back to oxagen.ai is a single env-var sweep when the brand domain
is ready — keep the URL values isolated to env vars and config, not hard-
coded in source.

## Linear

Oxagen uses the `oxagen-v2` linear project. Access the linear project via
apis or the linear mcp server. The api key is stored as an environment
variable in the root of this repo.

### Ticket convention (apply on every ticket you create)

- **One ticket = one pull request.** Never split a single PR across two
  tickets. Never bundle two unrelated PRs into one ticket. The goal is
  one CI run per ticket so the user's Vercel build budget is preserved.
- **Sub-issues for chunks of work** *inside* the ticket. A sub-issue is
  a tracking unit (a reviewer can resolve them as each chunk merges into
  the parent branch), not a separate PR. Aim for 3–6 sub-issues per
  parent ticket; more is a sign the parent is too big.
- **Assignee: Mac Anderson** (`mac@oxagen.ai`,
  uuid `aa47fc28-1b3a-4b45-bb02-d18f2e59c6bb`). Always set on creation.
- **Labels — every ticket:** Call `list_issue_labels` to get the live
  set — do not guess or hard-code. The active taxonomy (~28 slugs, ≤50
  cap) includes: `web-app`, `mobile-ux`, `api`, `mcp`, `knowledge-graph`,
  `ingestion`, `connectors`, `agents`, `agent-memory`, `content-studio`,
  `llm`, `automation`, `auth`, `billing`, `security`, `soc-2`,
  `observability`, `infra`, `ci`, `database`, `performance`, `reliability`,
  `bug`, `epic`, `tech-debt`, `testing`, `user-docs`, `adr`.
  Labels `agent-created`, `foundations`, `application-shell`, `iam`,
  `SOC2` no longer exist — do not use them. Add a new label with
  `create_issue_label` only when no existing slug fits; keep the total
  under 50.
- **T-shirt size** every ticket using Linear `estimate`:
  - XS (1): ≤1h, single-file, no schema impact, near-zero risk.
  - S (2): half-day, ≤5 files, isolated module, low risk.
  - M (3): one day, ≤20 files, one package, modest test surface.
  - L (5): multi-day, ≤100 files, crosses packages, moderate risk
    (e.g. requires a migration but no behavior change).
  - XL (8): week-plus, >100 files OR security-critical OR
    requires exhaustive testing OR touches IAM/audit boundary.
  Reconsider sizing on three axes — **risk** (what happens if it
  goes wrong?), **blast radius** (how many files/packages touched?),
  **effort** (raw time). The largest of the three sets the size.
- **Priority** matches business need, not "everything is Urgent."
  P1 = Urgent for foundation work that blocks other work; P2 = High
  for the next quarter's milestones; P3 = Medium / P4 = Low otherwise.
- **Description structure** — always include:
  1. One-sentence purpose.
  2. Link to the relevant `docs/architecture/<topic>/spec.md` (or the
     topic's `plan.md` / top-level architecture MD when no `spec.md`
     exists) section.
  3. What changes — explicit file list / migration name / contract
     id, not vague verbs.
  4. Acceptance criteria as a checklist.
  5. Risks + mitigations.
  6. Rollback plan.

Following this convention means future agent sessions can hand the user
a coherent backlog without re-deciding ticket shape each time.

## Operating model

**Default model: Haiku.** Haiku plans, routes, and handles the majority of
turns. Escalate explicitly — do not default upward.

### Escalation rubric (use this, not vibes)

Stay on **Haiku** for: single-file edits, reads, lookups, graph queries,
formatting, renames, doc tweaks, dispatching subagents, summarizing tool
output.

Escalate to **Sonnet** when any of these are true:
- change spans >3 files or crosses package boundaries
- requirements are ambiguous and need clarification or design choices
- writing non-trivial new logic (not just wiring existing pieces)
- debugging where the root cause isn't obvious from the first read
- reviewing a diff for correctness

Escalate to **Opus** when any of these are true:
- architectural decisions or changes to `/packages` public surfaces
- anything touching the storage boundaries below
- security-sensitive code (auth, permissions, billing, secrets)
- multi-system changes coordinating MCP + API + app
- incident triage with production impact

### Parallelism — when it pays, when it doesn't

Dispatch subagents **in parallel** when subtasks are genuinely
independent: multi-repo searches, reading N unrelated files, querying
different data stores, running independent test suites. Send them in a
single message with multiple tool calls.

Do **not** parallelize when:
- later steps depend on earlier results (just run sequentially)
- subtasks touch the same files (race conditions, merge pain)
- the work is small enough that dispatch overhead exceeds the gain
- you're parallelizing just to look busy

### Cost discipline

- Match model to task — don't run Opus on a one-line rename.
- For contract introspection, use `pnpm check:manifest --json` (cheap,
  accurate). For codebase exploration, batch file reads in one turn.
  The `ontology.*` graph query layer is **not yet shipped** — do not
  attempt those calls; they will fail. `agent.code.execute` IS wired
  (sandbox runner); use the contract, not raw `code.*` calls.
- Batch independent reads into one turn; don't chain them.
- A subagent is a context isolation tool, not a default. Use it when
  results would blow up the parent's context or when work is parallelizable.
- Prefer `Explore` agent (read-only, fast) over `general-purpose` for
  search-only tasks.

## Local frontend verification (encouraged every session)

You are **authorized and encouraged** to drive the local app in a browser to
verify your own frontend work — every session, any time you touch UI, without
asking permission first. Don't ship UI changes you haven't seen render.

**Credentials.** A reusable local-dev account lives in `creds.json` at the repo
root (gitignored — never commit it, never print the password in chat). It holds
the login email/password plus the seeded org/workspace slugs. Reuse it across
sessions. If the local DB was reset and login fails, recreate the account via
the signup flow below and update `creds.json` (keep the same email/password so
it stays stable).

**Spin up the stack.** The dev server is usually already running:
- `apps/app` → `http://localhost:3000` (check `lsof -ti:3000` first).
- `apps/docs` → `http://localhost:3300` (Fumadocs; statically served).
  `pnpm dev` starts both Next apps plus the API (4000) and MCP (4100) servers.
- Local Postgres is on `:5433` (Docker). `pnpm dev` brings up Docker + env.
- If port 3000 is free, run `pnpm dev` (needs Docker running).

**Log in / sign up (email+password, no social).** The whole app is auth-gated —
every route 307s to `/login` until you have a session. Email/password signup
auto-signs-in (no email verification locally).
1. Go to `/signup`, fill name/email/password from `creds.json`, submit.
2. A brand-new user lands on `/new-organization` — create the org (it also
   creates a default workspace), then you're at `/{org}/{ws}/ask`.
3. Returning sessions: use `/login` with the saved creds.

**Driving the browser.** Prefer the chrome-devtools MCP
(`mcp__plugin_chrome-devtools-mcp_chrome-devtools__*`) — it manages its own
browser. The Playwright MCP shares one profile and errors with "Browser is
already in use" when another session holds it; don't kill that browser (it may
be another agent's). The chrome-devtools `fill` tool **appends** to inputs and
its empty-string clear does **not** fire React's controlled `onChange`; to set
a React-controlled field reliably (or to clear one), use `evaluate_script` with
the native value setter + a bubbling `input` event.

## Key dependency versions

Pinned in `pnpm-lock.yaml`; check `apps/app/package.json` for app-level overrides.

- **Next.js `16.2.7`** — App Router, Turbopack default (extensionless imports).
  `proxy.ts` replaces `middleware.ts` (see below).
- **AI SDK `ai@6.0.x`** — use `modelIdOf()` to resolve model handles to gateway
  slugs; the v4/v5 web docs do NOT match this version. `streamText` /
  `generateObject` / `generateText` are the correct server-side APIs.
  `ai/rsc` (`streamUI`, `createStreamableUI`, `createAI`) is **forbidden**
  (experimental). `@ai-sdk/react` (`useChat` / `useCompletion`) is permitted
  on the client when needed (see App stack notes).
- **TypeScript `6.0.3`** — stricter inference; no `any`.

## App stack

### `apps/app` — interactive agent UI

- **Next.js App Router** with **React Server Components** and streaming.
- The interactive agent is built on the **Vercel AI SDK Core** (`ai`
  package — `streamText` / `generateText` / `streamObject` /
  `generateObject`) on the server. **Do NOT use AI SDK RSC**
  (`ai/rsc`, `streamUI`, `createStreamableUI`, `createAI`) — it is
  flagged experimental and not recommended for production. No experimental
  or unstable SDKs ship in this product.
- The primary chat path does **not** use `@ai-sdk/react` — it consumes the
  `POST /api/v1/chat/stream` SSE endpoint through the hand-rolled
  `use-tool-stream.ts` hook
  (`apps/app/src/components/chat/use-tool-stream.ts`). Do not roll a second
  transport alongside it. `@ai-sdk/react` (`useChat` / `useCompletion`) may
  be used on the client for **other** surfaces (e.g. lightweight form
  generation, secondary panels) where the full SSE pipeline is overkill —
  but never for the main chat path.
- Generative UI ("generate UI components from a prompt") is done **without
  RSC**: the model returns structured tool-call / `generateObject` output
  and the client maps it to React components via the chat component
  registry. The model streams *data*, not server-rendered React trees.
- Tool calls, generative UI, and message branching all flow through the
  SSE stream consumed by `use-tool-stream.ts` — do not reach for `ai/rsc`
  to get there.
- Server actions handle mutations; client components subscribe to
  streamed responses.
- Auth lives in server components; client never sees session tokens.
- **Request interception uses `proxy.ts`, not `middleware.ts`.** Next.js 16
  (this repo runs 16.2.x) deprecated and renamed the `middleware` file
  convention to `proxy` — the file lives at `apps/app/src/proxy.ts` and
  exports a `proxy` function. The file runs on the **Edge runtime** (no
  `export const runtime` override; default is edge for this convention).
  Keep `proxy.ts` edge-safe: cookie inspection, URL rewrites, and redirects
  only — no Node.js built-ins, no DB calls, no secrets. `middleware.ts` is
  no longer recognized; do not create one.

### `apps/api`, `apps/mcp`

- **`apps/api`** — Hono REST server. Routes live at
  `apps/api/src/routes/v1/<capability>.ts` (versioned, one file per
  capability). No UI. Thin shell over `packages/`.
- **`apps/mcp`** — xmcp server. Tools live at
  `apps/mcp/src/tools/<capability>.ts` (one file per capability).
  Connect at `/mcp` over streamable HTTP.
- **Capability parity rule:** any new user-facing action must also be a
  contract in `packages/oxagen/src/contracts/` (via `registerCapability`)
  wired into `apps/api/src/routes/v1/`, `apps/mcp/src/tools/`, and
  `apps/cli/src/commands/`. Run `pnpm check:manifest` to verify API↔MCP parity
  after adding a contract (CLI parity is tracked separately in Linear).
- **Parity caveat:** *contract-declared* capabilities are symmetric between
  API and MCP. However, a large number of UI sections are intentional static
  mocks with no backing contracts yet: `knowledge.*`, `access.*`, `security.*`,
  `activity.*`, `developer.*`, `tools/studio.*`, and several `billing/settings/profile`
  actions. These stub pages are tracked in Linear
  and must NOT be wired to live data until a contract exists. The correct
  order is: contract → API route → MCP tool → UI wire-up. Run
  `pnpm check:manifest` to get the current gap list.
- **`check:manifest` combined-route false positive** — the manifest script
  expects one file per capability (e.g. `workflow.run.ts`). When capabilities
  share a combined route file, the script reports a false-positive gap for each.
  Combined files currently in use:
  - `apps/api/src/routes/v1/workflow.ts` — covers `workflow.run`, `workflow.cancel`,
    `workflow.status` (false-positive `api` gap for each).
  - `apps/api/src/routes/v1/connection.ts` + `apps/mcp/src/tools/connection.ts`
    — covers all 8 `connection.*` capabilities (false-positive `api` **and** `mcp`
    gap for each).
  Verify by reading the combined file before filing a parity ticket.

### `apps/cli`

- Commander + Ink CLI. Entry: `apps/cli/src/index.tsx`. Ships 95 command
  files covering auth, orgs, workspaces, chat, conversations, API keys,
  plugins, billing, agents, workflows, images, documents, automation, forms,
  skills, and user preferences. `oxagen dev` is the dev-stack launcher and
  port-prober.

### `apps/docs`

- Fumadocs/MDX documentation site. Statically generated; deployed as
  `oxagen-v2-docs.vercel.app`. No interactive runtime features.

## Common commands

```bash
pnpm dev                         # start all apps + Docker (Postgres :5433, ClickHouse :8123, Neo4j :7687)
pnpm typecheck                   # run TS across the monorepo (do before push)
pnpm test                        # run test suite
pnpm check:manifest              # verify API↔MCP capability parity (warn-only)
pnpm check:manifest --json       # machine-readable parity output
pnpm check:contracts             # verify contract definitions
pnpm env:check                   # validate .env.local against schema
pnpm release:patch               # bump all packages to next patch version, tag, sync PLATFORM_VERSION to Vercel
pnpm release:minor               # bump all packages to next minor version
pnpm release:major               # bump all packages to next major version
pnpm db:migrate                  # apply pending Postgres migrations
pnpm db:lint-migrations          # verify migration file names and checksums
pnpm db:seed-iam                 # seed IAM roles and permissions
pnpm db:seed-skills              # seed agent skill definitions
pnpm db:backfill-iam             # backfill org IAM for existing orgs
pnpm gate                        # run full CI suite locally (lint + typecheck + test + build)
pnpm kill                        # kill all background processes (dev, docker, etc.)
pnpm env:pull                    # pull Vercel env vars to .env.local (dev only)
pnpm billing:stripe-sync         # sync meter pricing and discounts with Stripe
lsof -ti:3000                    # check if app dev server is already running
lsof -ti:4000                    # check if API server is running (port 4000)
lsof -ti:4100                    # check if MCP server is running (port 4100)
git fetch origin && git rebase origin/main  # sync before pushing (avoids force-push)
```

## Gotchas

- **`"use client"` boundary** — never call a `"use client"` function from a
  Server Component; the compiler won't catch it but it will blow up at runtime.
- **`invoke()` needs handler registration** — any file that calls `invoke()`
  must `import "@oxagen/handlers/register"` before the call; forgetting it
  silently no-ops the metering/IAM layer.
- **Turbopack extensionless imports** — Next.js 16 + Turbopack requires
  extension-free imports (e.g. `import Foo from "./Foo"` not `"./Foo.tsx"`).
- **`proxy.ts` not `middleware.ts`** — Next.js 16 renamed the interception
  file; `middleware.ts` is no longer recognized.
- **Raw `db()` is banned** — use `withTenantDb` / `withSystemDb` /
  `scopedSession`; the ESLint rule enforces this. `FORCE RLS` requires the
  `oxagen_app` non-superuser role.
- **Rebase before pushing to main** — other agents/users push to main
  concurrently; always `git fetch origin && git rebase origin/main` before
  `git push` to avoid non-fast-forward errors.
- **`apps/app` does not bootstrap IAM** — `invoke()` calls that originate
  inside `apps/app` (server actions, RSC data fetches) skip IAM role checks
  because `apps/app` never loads the IAM bootstrap. Only `apps/api` and
  `apps/mcp` enforce roles. When routing app code through `invoke()`, add
  explicit `assertBillingManager` / `assertOrgMember` gates at the call
  site; do not rely on the kernel to enforce them.
- **Better Auth `rateLimits` plural — prod-only 500** — `drizzleAdapter`
  with `usePlural: true` pluralizes `rateLimit` → `rateLimits`. The wrong
  table name produces a 500 on ALL auth calls in production but passes dev
  and e2e because rate-limiting is disabled locally. Always verify auth
  changes against a production-equivalent environment.
- **`tsx --env-file` does NOT override a shell `DATABASE_URL`** — seeding
  and migration scripts invoked with `tsx --env-file-if-exists=.env.local`
  use local DB even when `DATABASE_URL` is set in the shell. For prod DB
  operations, explicitly `unset DATABASE_URL` before running the script or
  use the Vercel env-scoped workflow (`gh workflow run ci.yml --ref main`).
- **Stripe webhook tunnel** — `pnpm dev` auto-starts the Stripe CLI tunnel
  (`stripe listen --forward-to ...`) via `tools/scripts/stripe-tunnel.ts`.
  If you restart `apps/api` in isolation (e.g. direct `tsx` invocation, not
  via `pnpm dev`), the tunnel stays alive but the per-session signing secret
  injected into `process.env.STRIPE_WEBHOOK_SECRET` is lost — restart the
  whole stack via `pnpm dev` to re-sync it.
- **AI Gateway slug drift** — gateway model slugs can be dropped/renamed
  silently; always use `modelIdOf()` to resolve handles, never hard-code
  slugs. Verify against live `/v1/models` when adding a new model.
- **`agent.subagent.dispatch` / `agent.subagent.aggregate`** — platform-level parallel orchestration. `dispatch` fans out sub-tasks and returns a run-ID per branch; `aggregate` collects results when all branches settle. Use these contracts instead of hand-rolling fan-out inside a handler; they emit proper lineage and metering through `invoke()`.
- **`prompt.settings.read` / `prompt.settings.write`** — platform-level prompt configuration, org+workspace scoped, stored in Postgres. When adding system-prompt customisation or model-behaviour knobs, reach for these contracts rather than hard-coding strings. They are metered and IAM-gated.
- **`agent.ui.render`** — generative UI contract. The model returns `generateObject` structured output; the client maps it to React components via the chat component registry. Never use `ai/rsc` or server-render React trees; this contract is the only approved path for model-driven UI generation.
- **`agent.ui.render` is agent-surface only** — its contract declares `surfaces: ["agent"]`; it has no MCP tool file and no API route by design. `pnpm check:manifest` will report a false-positive parity gap for it — this is expected. Do not add an MCP/API wrapper for this capability.

## All LLM calls must go through `@oxagen/ai`

Token metering (`token_usage` ClickHouse table), duration tracking, surface tagging, and prompt hashing are emitted **only** by the wrappers in `packages/ai/src/` (`generateObject`, `streamText` via `stream.ts`, `generateImage`, `generateVideo`, `embed`). Calling AI SDK (`ai`, `@ai-sdk/gateway`) directly bypasses all metering. Never import `generateText` / `streamText` / `generateObject` directly from `ai` inside a handler or route — always use the `@oxagen/ai` re-exports.

## Infrastructure boundaries

Authoritative. See AGENTS.md for the why.

**Note:** Architectural decisions at this level should be documented in `docs/adr/`
(e.g., ADR-012 for the connector dual-write pattern) with context, decision,
alternatives, and consequences. ADRs stay in the repo; design decisions do not
age in conversations.

### Neo4j — graph data only

- ontology and entity relationships
- workflow lineage and execution graphs
- agent memory and topology
- semantic retrieval

### PostgreSQL — transactional state only

- users, orgs, permissions
- billing
- configs and job metadata
- durable application state

### ClickHouse — append-only runtime events only

- execution events
- logs, metrics, traces
- token analytics and tool usage
- runtime telemetry and historical performance

### File / blob storage — binary assets only

- user and org avatars
- generated images, video, documents, PDFs, SVGs
- uploaded workspace files
- The blob lives here; its reference row (URL + metadata) lives in Postgres.
  Never store binary payloads in any of the three DB stores.
- Driver: Vercel Blob behind the `@oxagen/storage` vendor-neutral adapter
  (`BLOB_READ_WRITE_TOKEN`). Served via access-controlled `/api/v1/assets/[id]`
  (generated assets) or `/api/v1/files/[id]` (workspace files).

**Never:** analytics in Neo4j. Graph relationships in Postgres.
Transactional state in ClickHouse. Binary payloads in any of the three DB stores.

**Exception — Connector Data Ingestion Dual-Write:**
Data connectors (GitHub, Linear, Salesforce, etc.) use a dual-write pattern:
**Postgres** stores the operational record (sync cursor, connection health, event log —
ACID, must never lose). **Neo4j** stores the indexed graph (entities, embeddings,
relationships — async Inngest, retryable). This is not a violation of the rule above
because they serve different purposes: Postgres ensures operational durability; Neo4j
enables graph queries. Write both, but understand Postgres is the source of truth
for cursor state. ClickHouse observes ingestion events for telemetry.

## Documentation — capability registry

**`docs/capabilities/` must stay in sync with live contracts.** The directory
contains markdown files for every user-facing capability (API endpoints, MCP
tools, CLI commands). It is the single source of truth for product documentation
shipped to the website and agent-facing systems. **Currently, capability docs
are manually maintained** (see **Gaps** below). Automated regeneration is
tracked in Linear.

- **When to update:** Whenever a contract is added, renamed, or removed
  (not just parameter changes).
- **How to update:** Manually create `.md` files in `docs/capabilities/` per
  capability using the pattern from existing files. Filename is the capability
  name in kebab-case (e.g., `workflow.run.md`). Update `_index.md` for new
  capabilities.
- **Before pushing:** Manually verify `docs/capabilities/` matches contracts
  in `packages/oxagen/src/contracts/`, `apps/api/src/routes/v1/*`,
  `apps/mcp/src/tools/*`, and `apps/cli/src/commands/*`. Stale or missing docs
  cause drift between shipped product and agent knowledge.
- **Gaps (last audited 2026-06-09):** `pnpm check:manifest` reports **14** missing-docs
  entries: `agent.execution.record`, `agent.plan.create`, `agent.subagent.aggregate`,
  `agent.subagent.dispatch`, `agent.ui.render`, `chat.message.execution`, and all 8
  `connection.*` capabilities. A further **12** capabilities have no `docs/capabilities/`
  file but omit `"docs"` from their contract `layers[]`, making them invisible to
  `check:manifest`: `document.create`, `document.list`, `document.read`, `form.create`,
  `form.submit`, `image.analyze`, `image.create`, `image.list`, `prompt.settings.read`,
  `prompt.settings.write`, `skill.workspace.list`, `workspace.member.list`. True total
  ~26 undocumented. Run `pnpm check:manifest` for tracked gaps; for the untracked 12,
  add `"docs"` to their contract `layers[]`. This count drifts; do not hard-code it.

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
  review. (CI gates still only run on PRs, so verify locally — typecheck + tests
  green — before pushing to main.)
- **Dangerous, breaking edits are allowed**, including changes that would break
  production, drop/rewrite schemas, or remove APIs. Move fast; don't tiptoe.
- The one non-negotiable: **everything you ship must be round and complete from a
  functionality perspective** — fully wired end-to-end, every layer present (no
  half-built features, no `dall-e-3`-style placeholders left charging $0), tests
  passing, no dead code. "Fast and breaking" is licence on *process and blast
  radius*, never on *completeness*. Pair this with the prime directive above.

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
  The `code.*` / `ontology.*` graph query layer is **not yet shipped**
  — do not attempt those calls; they will fail.
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
  wired into BOTH `apps/api/src/routes/v1/` and `apps/mcp/src/tools/`.
  Run `pnpm check:manifest` to verify parity after adding a contract.
- **Parity caveat:** *contract-declared* capabilities are symmetric between
  API and MCP. However, several UI-only billing/settings/profile actions are
  not yet contracted (tracked in Linear) and therefore NOT reachable from
  the MCP surface. Do not assume full API↔MCP parity — run `check:manifest`
  to get the current gap list.

### `apps/cli`

- Commander + Ink CLI. Entry: `apps/cli/src/index.tsx`. Provides the
  `oxagen dev` command (port-prober and dev-stack launcher).

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
pnpm db:migrate                  # apply pending Postgres migrations
pnpm db:lint-migrations          # verify migration file names and checksums
pnpm db:seed-iam                 # seed IAM roles and permissions
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
- **Stripe webhook tunnel** — `pnpm dev` auto-starts the Stripe CLI tunnel
  (`stripe listen --forward-to ...`) via `tools/scripts/stripe-tunnel.ts`.
  If you restart `apps/api` in isolation (e.g. direct `tsx` invocation, not
  via `pnpm dev`), the tunnel stays alive but the per-session signing secret
  injected into `process.env.STRIPE_WEBHOOK_SECRET` is lost — restart the
  whole stack via `pnpm dev` to re-sync it.
- **AI Gateway slug drift** — gateway model slugs can be dropped/renamed
  silently; always use `modelIdOf()` to resolve handles, never hard-code
  slugs. Verify against live `/v1/models` when adding a new model.

## Infrastructure boundaries

Authoritative. See AGENTS.md for the why.

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

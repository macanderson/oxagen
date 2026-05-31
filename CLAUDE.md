# CLAUDE.md

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
  `apps/app` / `apps/website` so output reads as Oxagen.
- **`frontend-patterns`** — a 136-entry library of web-platform technique guides
  (CSS, a11y, Core Web Vitals, forms/autofill, passkeys, view transitions,
  scroll animation, privacy, security). Use when building/reviewing frontend:
  open the one or two matching technique files, don't read the whole library.
- **`vendor-better-auth`** — documentation map (llms.txt index) for Better Auth.
  Use to jump to the right official doc; pair with the `*-best-practices` auth
  skills for hands-on setup.
- **`oxagen-code-audit`** — full-repo audit against the engineering law:
  fan-out auditors → adversarial verify → safe auto-fix in a worktree → Linear
  tickets for approvals → interactive HTML dashboard. Use when asked to "audit
  my code", "give me an audit report", or score package health.

Routing: code/schema/test/PR/CI → `oxagen-engineering-policy` first. Building UI →
`oxagen-design-system` (identity) + `frontend-patterns` (technique). Auth →
`vendor-better-auth` + the Better Auth `*-best-practices` skills. See
`.agents/skills/README.md` for the full local-skill manifest.

## Production URLs (interim)

Until oxagen.ai is launched, production deploys use Vercel-managed domains:

- App: `https://oxagen-v2-app.vercel.app`
- Website: `https://oxagen-v2-website.vercel.app`
- API: `https://oxagen-v2-api.vercel.app`
- Admin: `https://oxagen-v2-admin.vercel.app`

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
- **Labels — every ticket:**
  - `agent-created` (workspace label, mandatory)
  - One or more **functional-area** labels: `foundations`,
    `application-shell`, `iam`, `SOC2`, `security`, `observability`,
    `infra`, `tech-debt`, etc. Check `list_issue_labels` before
    inventing a new one. If a new area emerges (e.g. `command-menu`,
    `studio`, `agent-runtime`), create it with `create_issue_label`
    and write its description.
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
  2. Link to the relevant `docs/architecture/<topic>/spec.md` (or
     `plan.md`) section.
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
- Use the Oxagen graph (`code.*`, `ontology.*`) before opening files;
  graph queries are cheap, file reads are not.
- Batch independent reads into one turn; don't chain them.
- A subagent is a context isolation tool, not a default. Use it when
  results would blow up the parent's context or when work is parallelizable.
- Prefer `Explore` agent (read-only, fast) over `general-purpose` for
  search-only tasks.

## App stack

### `apps/app` — interactive agent UI

- **Next.js App Router** with **React Server Components** and streaming.
- The interactive agent is built on the **Vercel AI SDK** (`ai` package)
  with streaming UI — `streamUI` / `streamText` rendered through RSC.
- Tool calls, generative UI, and message branching all flow through the
  AI SDK's streaming primitives — do not roll a parallel transport.
- Server actions handle mutations; client components subscribe to
  streamed responses.
- Auth lives in server components; client never sees session tokens.
- **Request interception uses `proxy.ts`, not `middleware.ts`.** Next.js 16
  (this repo runs 16.2.x) deprecated and renamed the `middleware` file
  convention to `proxy` — the file lives at `apps/app/src/proxy.ts`, exports
  a `proxy` function, and runs on the Node.js runtime. `middleware.ts` is no
  longer recognized; do not create one.

### `apps/website`

- Next.js. Static / minimal. Hello-world surface for the foundations
  milestone — no interactive features.

### `apps/api`, `apps/mcp`

- Node services. No UI. Surface platform capabilities defined in
  `/packages` once and exposed identically through API and MCP.

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

**Never:** analytics in Neo4j. Graph relationships in Postgres.
Transactional state in ClickHouse.

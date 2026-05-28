# CLAUDE.md

## Linear

Oxagen uses the `oxagen-v2` linear project. Access the linear project via apis or the linear mcp server. The api key is stored as an environment variable in the root of this repo.

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

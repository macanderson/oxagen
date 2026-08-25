# Oxagen Engineering Onboarding

One doc. Read top to bottom. Part 1 is **how we write code**. Part 2 is
**what the database looks like today**. Part 3 is **why past decisions were
made**, with links to the full story. Everything else in `docs/` is detail —
this page is the map.

If a sentence here ever disagrees with the code, the code wins — open a PR
to fix this doc.

---

## Part 0 — What is Oxagen?

Oxagen is a control room for companies that build AI agents and sell access
to them. Three jobs, one platform:

1. **Rules** — every agent action is checked against a contract (who can do
   what, with which data, for how much) before it runs.
2. **Facts** — agents answer questions using a knowledge graph, not guesses,
   and can always show their source.
3. **Money** — every action an agent takes is measured and turned into a
   customer's bill.

Full pitch: [`VISION.md`](./VISION.md). Customers can plug in their own AI
keys and their own graph database — we never lock them in.

---

## Part 1 — How we write code (the principles)

**1. Fix it now.** Find a bug, a dead file, a wrong price, a stale config?
Fix the real cause, everywhere it appears, before moving on. Don't leave a
note for later.

**2. Small, safe pieces.** Don't build more than what was asked for. Three
similar lines of code beat one clever shortcut nobody can read.

**3. Branch, commit, push, open a PR.** Nobody edits `main` directly.
Cut a branch, save your work often, push it often, open a pull request.
The full test suite runs in that PR, not on your laptop.

**4. Test what you touch, not the whole repo.** Run the one test file
next to the code you changed. Never run the entire test suite yourself —
that's CI's job.

**5. Every store has one job.**
   - **PostgreSQL** — real business records (users, orgs, bills, permissions).
   - **Neo4j** — facts and relationships (the knowledge graph).
   - **ClickHouse** — a diary of everything that happened (events, logs, usage).
   - **Blob storage** — files (images, PDFs, uploads).

   Never put one store's job in another store.

**6. One way in, one way out.**
   - All AI model calls go through `@oxagen/ai` — never call the raw AI SDK.
   - All new user-facing actions are a **contract** first
     (`packages/oxagen/src/contracts/`), then an API route, then an MCP
     tool, then a CLI command, then a real screen in the app. Skipping a
     step is a bug, not a shortcut.
   - All Postgres reads/writes go through `withTenantDb` / `withSystemDb`.
     Never call the raw database client directly.

**7. Every table remembers who and when.** Business tables get a
generated id, a friendly public id (like `agt_xxxxx`), created/updated
timestamps, and a soft-delete flag instead of a hard delete. See
[the standard columns](#standard-columns) below.

**8. Multi-tenant by default.** Almost every table belongs to one
organization and one workspace. Queries are always scoped — no table scan
should ever be able to see another customer's data.

**9. Verify, don't assume.** A task isn't done because you wrote the code —
it's done when you've run it and can show the output (a test result, a
screenshot, a query result).

**10. Name things plainly.** kebab-case file names, `snake_case` database
columns and capability names, `SCREAMING_SNAKE_CASE` constants, `is`/`has`
prefixes for booleans.

**11. Never guess a model name or price.** Always resolve models through
`modelIdOf()` and read pricing from the live source — hard-coded values
rot.

**12. When you're not sure how to build a UI, database change, or test —
check `.claude/skills/` first.** The playbooks already exist; don't
reinvent them.

---

## Part 2 — What the database looks like today

### The four stores

| Store | Holds | Example |
|---|---|---|
| **PostgreSQL** | Transactional truth: users, orgs, billing, permissions, job state | "Org Acme has 3 workspaces" |
| **Neo4j** | The knowledge graph: entities and how they relate, time-aware | "This invoice cites this contract clause" |
| **ClickHouse** | Append-only events: every execution, tool call, and token spent | "Agent X ran tool Y at 3:04pm, cost $0.02" |
| **Blob storage** | Files: avatars, generated documents, uploads | An uploaded PDF |

Data only moves between stores through a metering pipeline (usage →
billing) or a connector's dual-write (Postgres record + Neo4j index). It
never leaks sideways for convenience.

### Standard columns

Every Postgres table is built from small, reusable pieces
(`packages/database/src/schema/_mixins.ts`):

| Mixin | Adds | Used on |
|---|---|---|
| `idMixin` | UUID `id` + a readable `public_id` (e.g. `agt_9f2k...`) | every table |
| `auditMixin` | `created_at`, `updated_at`, `created_by_user_id`, `updated_by_user_id` | tables people edit |
| `appendOnlyAuditMixin` | `created_at`, `created_by_user_id` only | log/event tables, never updated |
| `softDeleteMixin` | `deleted_at`, `deleted_by_user_id` | almost every org-owned table — hard deletes are banned |
| `orgScopeMixin` | `org_id`, `workspace_id` | every org-owned table |
| `versionMixin` | `version_number`, `is_latest`, `parent_version_id`, `published_at` | immutable snapshots (agent versions, playbook versions) |
| `executionStatusMixin` | `status` + start/complete/fail/cancel timestamps | anything that runs (executions, jobs, runs) |

### Postgres tables, by domain

Each domain is its own Postgres schema (namespace) and its own file under
`packages/database/src/schema/`. ~123 tables total; grouped here by what
they're for, not listed column-by-column — open the file for the real
shape.

| Domain (schema) | File | What lives here |
|---|---|---|
| `auth` | `auth.ts` | `users`, `sessions`, `accounts`, `api_keys`, `two_factor`, preferences — Better Auth's tables |
| `org` | `org.ts` | `organizations`, `org_users`, `invitations`, slug history |
| `workspace` | `workspace.ts` | `workspaces`, workspace membership, memory/budget/routing policy |
| `iam` | `iam.ts` | `principals`, `roles`, `role_grants`, access requests, authorization decisions — who can do what |
| `agent` | `agent.ts` | Agent definitions and versions, skills, executions, subagent fan-out, sandboxes, plans, file locks, run/attempt/checkpoint ledger (24 tables — the biggest domain) |
| `workflow` | `workflow.ts` | Playbooks: definitions, steps, edges, triggers, runs, approvals |
| `chat` | `chat.ts` | `conversations`, `messages` |
| `billing` | `billing.ts` + `reseller.ts` | Plans, subscriptions, invoices, credits, Stripe events, spend budgets, and reseller price plans/customers/rebilling |
| `mcp` | `mcp.ts` | MCP server registries, credentials, consents, catalog |
| `plugin` | `plugin.ts` | `installed_plugins` |
| `ingestion` | `ingestion.ts` | Data connectors: source connections, OAuth tokens, webhooks, GitHub installs, repo bindings |
| `schema_registry` | `schema-registry.ts` | The graph's own schema: node labels, relationship types, properties, versions |
| `environments` | `environments.ts` | Sandboxes, secrets, secret access log, agent-environment bindings |
| `security` | `security.ts` | Security events, org security policy, MCP change log |
| `privacy` | `privacy.ts` | Data export/erasure requests |
| `notification` | `notification.ts` | `notifications` |
| `ai` | `ai.ts` | `response_cache`, `batch_jobs` |
| `eval` | `eval.ts` | Eval datasets and runs |
| `cms` | `cms.ts` | `leads`, book editions/access codes (marketing site content) |
| `content` | `content.ts` | Generated assets, documents |
| `ratelimit` | `ratelimit.ts` | Rate limit counters |
| `evidence` | `run-evidence-foundation.ts` | Retention policy versions |

Migrations live in `packages/database/atlas/migrations/`, applied with
Atlas. Never hand-edit `atlas.sum`.

### Neo4j (the graph)

Entities and relationships, grounded with citations and time-awareness.
Never query it directly — go through the `ontology.*` contracts
(`ontology.neighbors`, `ontology.query`). The graph's own schema (what
labels and relationship types are allowed) is itself governed, stored in
Postgres's `schema_registry` tables above.

### ClickHouse (the meter)

Append-only. Every agent execution, tool call, and token spent is written
here and never updated. This is the source of truth that turns into a
customer's Stripe invoice.

---

## Part 3 — Why: the ADR index

An **ADR (Architecture Decision Record)** is a short, permanent note: what
we decided, and why. ADRs are never edited after acceptance — a changed
mind gets a new ADR that supersedes the old one. Full text lives in
[`docs/adr/`](./adr/); one-line summaries below.

### Foundations

| ADR | Decision |
|---|---|
| [001](./adr/ADR-001-drizzle-as-postgres-orm.md) | Drizzle ORM for Postgres |
| [002](./adr/ADR-002-inngest-as-job-orchestration.md) | Inngest for durable background jobs |
| [003](./adr/ADR-003-neo4j-as-vector-store.md) | Neo4j doubles as the vector store |
| [004](./adr/ADR-004-env-vars-not-secret-manager.md) | Plain env vars, not a secret manager (for now) |
| [005](./adr/ADR-005-single-version-monorepo.md) | One version number for the whole monorepo |
| [006](./adr/ADR-006-better-auth-bound-to-canonical-users.md) | Better Auth writes straight into our `auth.users` table |

### Agent runtime

| ADR | Decision |
|---|---|
| [007](./adr/ADR-007-docker-as-code-sandbox.md) | Docker, short-lived containers, as the code sandbox |
| [008](./adr/ADR-008-skills-filesystem-first.md) | Skills live on disk first, database second |
| [009](./adr/ADR-009-unified-capability-tool-model.md) | Tools *are* capabilities — one model, not two |
| [010](./adr/ADR-010-subagent-fanout-via-inngest.md) | Subagents fan out via Inngest's `step.invoke()` |
| [011](./adr/ADR-011-vercel-sandbox-driver.md) | A Vercel Sandbox driver for Vercel-hosted functions |
| [019](./adr/ADR-019-unified-agent-engine.md) | One shared agent "brain," adapters per environment |
| [021](./adr/ADR-021-inference-doctrine.md) | The "determinism ladder" — when to let the model decide vs. code |
| [023](./adr/ADR-023-cli-fleet-session-event-log.md) | Every unit of agent work is a session with an append-only log |
| [028](./adr/ADR-028-time-travel-replay.md) | Every fleet session gets a replayable event record |
| [029](./adr/ADR-029-mutation-verifier-gate.md) | A deterministic gate checks agent-made changes after the fact |
| [030](./adr/ADR-030-speculative-tool-execution.md) | Speculatively run likely-next tool calls ahead of confirmation |
| [033](./adr/ADR-033-stella-engine-core.md) | Adopt the Stella engine core |

### Marketplace & plugins

| ADR | Decision |
|---|---|
| [012](./adr/ADR-012-connector-dual-write-pattern.md) | Connectors write to Postgres (record) and Neo4j (index) — not a duplication, two purposes |
| [013](./adr/ADR-013-oxagen-plugins-capability-packs.md) | Oxagen Plugins: first-party capability packs as a plugin type |
| [014](./adr/ADR-014-workspace-scoped-mcp-registry-single-default.md) | MCP registries are workspace-scoped, one default enforced by the database |
| [034](./adr/ADR-034-customer-capability-packages.md) | Customers can author their own capabilities as code in their own repo |

### Naming & identity

| ADR | Decision |
|---|---|
| [022](./adr/ADR-022-capability-naming-standard.md) | Capability names: `domain.subject.action` |
| [024](./adr/ADR-024-namespaced-agent-identity.md) | Orgs and workspaces get namespaces, not bare slugs |
| [025](./adr/ADR-025-verb-first-snake-naming.md) | New standard: `verb_noun` snake_case (supersedes 022's dotted form for new names) |

### Developer workflow & CLI

| ADR | Decision |
|---|---|
| [015](./adr/ADR-015-graph-edge-driven-git-hooks-and-biome.md) | Pre-push test selection via the Vitest import graph; Biome for formatting |
| [016](./adr/ADR-016-oxagen-cli-daemon-live-code-graph.md) | `oxagend`, a local daemon keeping a live code graph (Proposed) |
| [017](./adr/ADR-017-opentelemetry-distributed-tracing.md) | OpenTelemetry as the vendor-neutral tracing layer |
| [018](./adr/ADR-018-cli-workspace-graph-bidirectional-sync.md) | CLI workspace graph syncs both directions |
| [020](./adr/ADR-020-per-workspace-github-write-credentials.md) | One resolution chain picks the right GitHub write token per workspace |
| [026](./adr/ADR-026-mobile-feature-parity.md) | Anything usable on desktop must be usable on mobile |
| [027](./adr/ADR-027-multi-tenant-github-app-connect.md) | GitHub Connect is driven by identity first, installation second |

### Data & storage

| ADR | Decision |
|---|---|
| [031](./adr/ADR-031-platform-storage-ontology.md) | The Platform Storage Ontology: one deterministic map of what goes where |
| [032](./adr/ADR-032-unified-chat-session-state.md) | One state object, one write path, per conversation |
| [035](./adr/ADR-035-consume-context-graph-protocol-directly.md) | Pin the Context Graph Protocol directly rather than re-wrapping it |
| [036](./adr/ADR-036-adopt-cgp-typescript-sdk.md) | `@oxagen/run-evidence` adopts the CGP TypeScript SDK |

---

## Where to go next

- Full product vision and drift tests → [`VISION.md`](./VISION.md)
- Per-capability reference docs → [`capabilities/_index.md`](./capabilities/_index.md)
- How-to guides (connectors, storage drivers, partner onboarding) → [`guides/`](./guides/)
- Operational runbooks → [`ops/`](./ops/)
- Canonical queries per store → [`queries/`](./queries/)
- Everything else about how `docs/` is organized → [`README.md`](./README.md)
- Repo-wide engineering rules Claude Code follows → root `CLAUDE.md`

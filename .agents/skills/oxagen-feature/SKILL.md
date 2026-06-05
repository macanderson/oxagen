---
name: oxagen-feature
description: Implement complete, production-grade features in the Oxagen codebase to the strictest standards. Use whenever the user asks to add, build, ship, fix, or implement a feature, capability, endpoint, agent tool, or MCP tool in Oxagen, even if they describe only one layer (e.g. "add an API route for X"). A feature in Oxagen is never a single deliverable. It fans out across a shared capability declaration, the Drizzle schema, the /v1 API route, the matching MCP tool, Vitest and Playwright tests, user docs and SPEC, marketing copy when user-facing, an async or batch variant when applicable, and a Linear entry in oxagen-v2. The skill also enforces domain-based file organization, shared-package reuse with zero copy-paste, performance patterns, inline architecture comments, querying the typed code graph before changing code, and recording weighted memories via the Oxagen plugin. Trigger it to stop drift and ship every layer with parity intact and CI green. Do NOT use for pure styling changes that add no capability.
---

# Oxagen Feature Implementation

## Why this skill exists

In Oxagen a "feature" is a **capability contract**, not a chunk of code. One capability fans out across many layers, and shipping only some of them is the failure mode this skill prevents. When the API gains a capability but the MCP tool lags, agents and humans see different systems. When code ships without tests, docs, or marketing, the feature is invisible or fragile. Treat every feature request, however narrowly phrased, as a request to satisfy the **full contract below**.

The stack is full TypeScript on Next.js App Router, deployed to Vercel, with the Vercel AI SDK as the agent-runner backbone, Drizzle for Postgres, the official Neo4j driver for the knowledge graph, Zod for schemas, Vitest for unit tests, and Playwright for E2E. Monorepo via Turborepo and pnpm. There is no Python in v2. Do not introduce FastAPI, SQLModel, Celery, or Python workers.

## The single source of truth

Parity is structural, not remembered. Every capability is **declared once** and every layer **imports from that declaration**, so drift becomes a compile error or a manifest mismatch rather than something to notice by hand.

1. **Shared package** (`packages/oxagen`): the capability registry entry plus its Zod input/output schemas. The Drizzle schema, the `/v1` route, and the MCP tool all import these. One change propagates; divergence fails to typecheck.
2. **Generated manifest** (`packages/oxagen/capabilities.manifest.json`): a derived artifact listing every capability and which layers implement it. The verification gate diffs the manifest against the filesystem to catch any skipped layer.

## Before you touch anything: query the code graph

Always query the typed code graph through the Oxagen plugin to Claude Code **before** writing or changing code. This is unconditional and cheap, and it is how you avoid reimplementing something that already lives in a shared package. Use it to find existing capabilities, shared utilities, and the nodes your change will touch. If the plugin or graph is unavailable, say so explicitly rather than proceeding blind.

The loop is: **query the graph, make the change, write a weighted memory against the touched node.** Always log for audit; weight governs what retrieval surfaces. See "Record what you learn" below.

## Engineering standards (apply to every layer)

These are not style preferences. They are conditions for the code being acceptable.

### Domain-based file organization
Organize by domain and feature, never by technical type. A capability's code lives together under its domain, not scattered into global `controllers/`, `models/`, `utils/` buckets. Colocate the capability declaration, business logic, schema, route, tool registration, and tests by the domain they serve. If you find yourself adding to a type-named grab-bag folder, stop and place the code in its domain instead.

### Shared packages, never copy-paste
Reuse happens through shared packages in the monorepo, full stop. If logic is needed in two places, it lives in a package both import. Copying a function, a type, or a schema into a second location is a defect, not a shortcut. Before writing a utility, query the graph to check whether it already exists. The API route and the MCP tool calling the *same* business-logic function is the canonical example: one implementation, many call sites.

### Performance patterns (required, not optional)
Write code that holds up at enterprise scale by default:
- No N+1 queries. Batch and join. If you are issuing a query inside a loop over rows, you have an N+1; fix it.
- Stream or paginate large payloads. Never load an unbounded result set into memory or return it whole.
- Every tenant-scoped query filters on an indexed `tenant_id` (and `workspace_id` where relevant). An unindexed scoped query is a performance and isolation bug at once.
- Paginate every list endpoint. No endpoint returns "all rows."
- Prefer set-based and batch operations over per-item round trips, consistent with Oxagen's batch-first design.

### Inline architecture comments
Comment the *decisions*, not the obvious. Where you choose sync over async, denormalize, pick a transaction boundary, accept an eventual-consistency window between Postgres and Neo4j, or deviate from a convention, leave an inline comment explaining *why*, so the next reader (human or agent) inherits the reasoning. Do not narrate self-evident code. Comment the non-obvious architectural call.

## Decide the execution mode FIRST

Before writing anything, decide whether the capability is **sync**, **async**, or **batch**. This is not a final step, it is the first decision, because it changes the schema shape and the route shape. Deciding late is where the worst rework lives.

- **Sync**: returns its result in the request. Default for fast, single-item operations.
- **Async**: enqueues work, returns a job handle, result fetched later. Use for long-running or rate-limited work (LLM chains, large graph writes).
- **Batch**: accepts many inputs, processes them as a set, returns per-item results or a batch handle. Use whenever callers will plausibly want N at once. Oxagen favors composable, batch-enabled capabilities, so default to designing batch-capable inputs unless there is a clear reason not to.

Record the chosen mode in the registry entry. The route and MCP tool templates branch on it.

## The layer contract

Implement these in dependency order. Every layer is non-negotiable except the two marked conditional. Read the matching template in `references/` before writing each layer; copy the skeleton, then fill it in rather than improvising.

1. **Capability declaration** — `packages/oxagen`. Registry entry + Zod schemas + execution mode. See `references/capability.md`.
2. **Drizzle schema + migration** — schema change and a generated migration. See `references/schema.md`.
3. **API route** — `/v1` Next.js route handler importing the shared schemas, with structured logging at appropriate levels. See `references/api-route.md`.
4. **MCP tool** — a tool mirroring the capability, importing the same shared schemas so API/MCP parity is structural. See `references/mcp-tool.md`.
5. **Unit tests (Vitest)** — cover the capability logic and schema validation, including batch and error paths. See `references/tests.md`.
6. **E2E tests (Playwright)** — exercise the route end to end against a running app. See `references/tests.md`.
7. **User docs + SPEC** — update or create `SPEC.md` for the feature and the relevant user-facing docs and README. See `references/docs.md`.
8. **Marketing copy (conditional)** — when the capability is user-facing, update the marketing site so the shipped feature is visible. Skip only when the capability is purely internal infrastructure. See `references/marketing.md`.
9. **Async/batch variant (conditional)** — when the mode is async or batch, ship the worker/queue handler and its job-status surface alongside the sync path. See `references/async-batch.md`.
10. **Linear documentation** — record the work in the `oxagen-v2` Linear project via the connected Linear MCP. Create or update an issue describing the capability, the layers shipped, and the execution mode, and link the SPEC. This is the human-readable provenance trail; it is not optional.

## Conventions that apply to every layer

- Production-ready code only: structured logging with correct levels (debug for tracing, info for lifecycle, warn for recoverable issues, error for failures), separated concerns, no stubbed error handling.
- Active voice, present tense, and Oxford commas in all prose and docs. Intent first, then implementation. No fluff.
- Frontend uses Tailwind v4 and shadcn, glassmorphism aesthetic, light and dark mode, rich transitions, per house style.
- Multitenant by default: capabilities respect tenant and workspace scope. Never write a query that can cross tenant boundaries.
- The `/v1` prefix is fixed for API routes.
- Document every shipped capability in the `oxagen-v2` Linear project. Provenance is part of the work, not an afterthought.

## Record what you learn (the memory loop)

Memory in Oxagen serves two needs at once, and they pull in opposite directions, so the skill keeps them separate. **Auditability** wants a complete, append-only record of every change against the node it touched, because an audit trail is only as good as its completeness and cannot be reconstructed after the fact. **Retrieval signal** wants sparsity, because a future agent querying "what should I know before changing this node" must not drown in routine entries. Weight reconciles them.

The rule: **always query the code graph before changing anything, and always write a memory against the relevant node, carrying a weight. Log everything for audit; let weight govern what retrieval surfaces.** Nothing is discarded. Routine entries simply carry low weight and sink below the retrieval threshold, so the well stays clean without losing the record.

### Weighting, for now

Do not build a scoring model yet. Oxagen is building Oxagen, so there is no production signal to calibrate against, and anything hand-tuned today gets thrown away once real retrieval and real incidents reveal what matters. Use a coarse, honest bucket implied by the event kind:

- `low` — routine, self-evident change (added a field, wired a known pattern). Logged for audit, does not surface in default retrieval.
- `high` — a non-obvious lesson: a discovered constraint, a root cause invisible from the code, a deliberate convention deviation, a gotcha tied to a node.
- `critical` — reserved for production incidents and bug-root-causes once exception watchers and bug reports come online.

No weighting math. The event kind picks the bucket. When production data exists to earn a real numeric weight, replace the buckets then, not now.

### Memory structure

```json
{
  "nodeRef": "<code-graph node id or path the memory attaches to>",
  "weight": "low | high | critical",
  "kind": "routine-change | constraint | bug-root-cause | convention-deviation | gotcha",
  "lesson": "One or two active-voice sentences. For low-weight, a terse record of what changed.",
  "source": "feature | fix | exception-watcher | bug-report"
}
```

Write it through the Oxagen plugin so it lands on the node. Default retrieval reads `high` and `critical`; audit and checkpointing read everything. The `source` field anticipates the future: today it is `feature` or `fix`, later the same store absorbs `exception-watcher` and `bug-report` memories under the identical retrieval contract. See `references/memory-loop.md` for the full contract.

## The verification gate

A feature is **not done** until the gate passes. This is the same end-to-end CI that runs in the pipeline; honor it locally before reporting done, and never report a feature shipped with a failing or unrun gate.

```bash
pnpm lint                  # domain organization + no-copy-paste lint rules
pnpm tsc --noEmit          # parity is structural; divergence fails here
node scripts/check_manifest.mjs   # regenerate + diff the manifest
pnpm vitest run            # unit tests pass
pnpm playwright test       # E2E tests pass
```

These are the strictest standards: zero type errors, zero lint violations, a clean manifest diff, and green unit and E2E suites. A red CI is a blocked feature, not a judgment call. After the commands pass, walk the layer contract explicitly and confirm each layer is satisfied or correctly skipped with its reason. The `check_manifest.mjs` script regenerates the manifest from the registry and reports any capability missing a required layer.

## Self-check before reporting done

Ask yourself, in order:
- Did I query the code graph before changing anything?
- Did I declare the capability once and import it everywhere, or did I duplicate a schema or copy-paste logic?
- Is the code organized by domain, not by technical type?
- Does the MCP tool expose exactly what the API does, no more, no less?
- Did I pick the execution mode deliberately, and does the schema reflect it?
- Do the performance patterns hold (no N+1, paginated, indexed scoped queries, streamed large payloads)?
- Did I comment the architecture decisions, not the obvious code?
- Are batch and error paths tested, not just the happy path?
- If this is user-facing, does the marketing site reflect it?
- Did I document the capability in the `oxagen-v2` Linear project?
- Did I write a memory against the touched node, weighted by event kind (low for routine, high for a lesson)?
- Does the full end-to-end gate pass clean?

If any answer is no, the feature is not done.

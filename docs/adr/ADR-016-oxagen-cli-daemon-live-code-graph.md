# ADR-016 — Oxagen CLI daemon: a live code-graph memory fed by coding-agent hooks

**Date:** 2026-06-24
**Status:** Proposed
**Epic:** CLI & Local Agent Runtime

> **Superseded for launch (2026-07-21).** The live local code-graph goal survives,
> but its cloud-sync, server-side exact-code-graph, and generic inference paths do
> not. The exact graph stays local to each checkout/worktree. Oxagen retains stable
> provider metadata and durable traces; canonical protected/default-ref topology
> and typed run evidence are separate follow-ups.

## Context

Oxagen's value is a knowledge graph that is never out of date. Today that graph is fed
by *connectors* (GitHub, Linear, …) on a poll/webhook cadence — minutes-to-hours stale,
and blind to in-flight, uncommitted work. When a developer (or a coding agent like Claude
Code) edits files locally, nothing observes those edits until they are committed, pushed,
and re-ingested. So if you ask the Oxagen CLI "what is the blast radius of this change?"
mid-edit, it answers from a stale picture and is, by construction, wrong.

The end goal is bigger than a query: **we want to run Oxagen's product-engineering agents
from the `oxagen` CLI instead of from inside Claude Code.** For that, the CLI must hold a
continuously-current model of the working tree — every edit, every tool call, every session
boundary — and be able to reason over it (blast radius, impacted tests, ownership) and to
sync that model to the cloud so the rest of the platform shares it.

There is meaningful prior art already in the tree, all of which this ADR formalizes and
absorbs rather than replaces:

- **Edit telemetry exists but is fire-and-forget and CC-specific.** `.claude/settings.json`
  (PostToolUse / Stop hooks) invokes `tools/scripts/claude-telemetry-logger.ts`, which
  appends tool-use lines to `~/.claude/claude-code-telemetry.jsonl`;
  `tools/scripts/sync-claude-telemetry.ts` flushes them to ClickHouse
  `internal.agent_executions`, and `tools/scripts/claude-session-summary.ts` /
  `backfill-claude-telemetry.ts` roll up sessions into `internal.claude_sessions`.
  `tools/scripts/oxagen-run-record-edit.sh` drops a per-session edit marker. This is a
  *telemetry* pipeline — it counts edits, it does not model them.
- **Agent memory already lives in Neo4j**, org+workspace-scoped, with embeddings and a
  vector index (`packages/agent/src/memory/neo4j.ts`, contracts `agent.memory.recall|write`).
- **The capability kernel** (`packages/oxagen/src/kernel.ts` `invoke()`, `@oxagen/handlers/register`,
  `bootstrapEntitlementRuntime()` from `@oxagen/plugins`, `runInTenantScope()` from
  `@oxagen/tenancy`) is the one legal path to call cloud capabilities with metering + IAM.
- **There is no code-structure graph.** A thorough search found `agent.code.execute`
  (sandbox *execution*) and `workflow.*` lineage, but **no** `code.structure.*`,
  `dependency.*`, `lineage.*`, or "typed code graph" implementation. CLAUDE.md's "query the
  typed code graph before changing code" is aspirational. **The blast-radius ontology must
  be designed fresh — this ADR does so.**

The four-store law (CLAUDE.md "Infrastructure boundaries") is binding: **Neo4j = graph**,
**ClickHouse = append-only events**, **Postgres = transactional state**, **blob = binaries**.

## Decision

Ship a long-lived local **daemon** — working name **`oxagend`**, launched and managed by
the CLI (`oxagen daemon …`) — that:

1. Exposes a **vendor-neutral local hook protocol** over a Unix domain socket. Coding agents
   push lifecycle events: `session.start`, `pre_tool_use`, `post_tool_use`, `session.end`.
   The first concrete integration is a **Claude Code adapter** that reuses the existing
   `.claude/settings.json` hook wiring; Codex/Cursor/Oxagen's own agents plug into the same
   protocol later.
2. Maintains an **in-memory code + edit graph** of the working tree — the hot cache — built
   incrementally from edit events and an initial repo scan.
3. Answers **blast-radius** and impact queries locally and instantly (`oxagen blast-radius <path>`).
4. **Syncs the graph to the cloud** per the four-store split chosen for this design:
   **code-structure nodes + edges → production Neo4j** (a *new* `Code*` ontology, distinct
   from the product knowledge graph, scoped org+workspace); **raw hook/edit events →
   ClickHouse** (extending the existing `internal.*` telemetry trail); **daemon/session
   metadata, sync cursors → Postgres**.

This ADR is **design only**. No daemon code lands with it. It defines the contract so the
build can proceed in reviewable phases on the contested `main` branch without rework.

### Component map

```
┌─ coding agent (Claude Code, Codex, oxagen agent) ─┐
│   hooks: session.start / pre|post_tool_use / end  │
└───────────────┬───────────────────────────────────┘
                │  JSON over $XDG_RUNTIME_DIR/oxagen/oxagend.sock  (adapter-translated)
                ▼
        ┌───────────────────────── oxagend (local daemon) ─────────────────────────┐
        │  ingest → normalize event → update in-memory graph → enqueue sync         │
        │                                                                           │
        │  • Hook server      Unix socket; one generic Event envelope               │
        │  • Graph engine     in-mem Code graph (files, symbols, imports, edits)    │
        │  • Query engine     blast-radius (reverse transitive closure), impacted   │
        │                     tests, ownership — answered from RAM, < 50ms          │
        │  • Sync engine      batched, cursor-tracked, offline-tolerant             │
        │  • WAL              append-only local journal (crash recovery + replay)   │
        └───────┬───────────────────────────┬───────────────────────────┬──────────┘
                │ Neo4j (graph)              │ ClickHouse (events)        │ Postgres (state)
                ▼                            ▼                            ▼
   Code* nodes + DEPENDS_ON/…     internal.agent_edit_events    daemon_sessions, sync cursors
   via invoke() + scopedSession   (append-only, via kernel)     (durable, ACID)
```

The daemon is a peer of `apps/api` (Hono) / `apps/mcp` (xmcp): it runs the same
**bootstrap** (`import "@oxagen/handlers/register"`, `bootstrapEntitlementRuntime()`, then
`runInTenantScope({orgId, workspaceId}, …)` around every `invoke()`), and authenticates to
the cloud with the CLI's existing token (`~/.config/oxagen/config.json`, `apps/cli/src/lib/config.ts`).
It lives in **`apps/cli/src/daemon/`** (shipping with the CLI binary) and reuses
`tools/scripts/inngest-dev.ts`'s detached-process + pidfile lifecycle pattern.

### The generic hook protocol

One envelope, agent-agnostic. Adapters translate a specific agent's hook payload into it:

```jsonc
// → oxagend over the socket, newline-delimited JSON
{
  "v": 1,
  "event": "post_tool_use",          // session.start | pre_tool_use | post_tool_use | session.end
  "session_id": "cc_01J…",           // opaque per-agent session key
  "agent": "claude-code",            // provenance; drives which adapter normalized it
  "ts": "2026-06-24T19:05:04.123Z",
  "cwd": "/home/.../oxagen-platform",
  "tool": { "name": "Edit", "ok": true },
  "edit": { "path": "apps/cli/src/index.tsx", "kind": "modify",
            "added": 6, "removed": 1, "hash_after": "sha256:…" }
}
```

- **Transport:** Unix domain socket at `$XDG_RUNTIME_DIR/oxagen/oxagend.sock` (perms `0700`),
  not TCP — no port, no remote attack surface, local-only by OS permission. Fire-and-forget
  writes; the agent never blocks on Oxagen (mirrors today's async telemetry hooks).
- **Claude Code adapter:** a thin `oxagen daemon hook` shim wired into `.claude/settings.json`
  PreToolUse/PostToolUse/SessionStart/Stop. It reads CC's stdin hook JSON, maps it to the
  envelope, writes to the socket, exits. This supersedes `claude-telemetry-logger.ts` and
  `oxagen-run-record-edit.sh` (which the daemon's event stream subsumes) — kept until the
  daemon path is proven, then removed.
- **Backpressure / liveness:** if the socket is absent (daemon down), the shim degrades to
  appending to the local WAL, which the daemon replays on next start. No event is lost; no
  hook ever fails the agent.

### Code-graph ontology (new, in Neo4j)

A dedicated label namespace, **disjoint from the product `KnowledgeNode` graph** (the user
chose "separate code-structure ontology"), but reusing the same tenant guard and citation
conventions (`displayName` + `label`, never raw ids in the UI):

| Node label   | Key props                                                  | Meaning                          |
|--------------|------------------------------------------------------------|----------------------------------|
| `CodeRepo`   | `publicId, orgId, workspaceId, remote, defaultBranch`      | a synced repository              |
| `CodeFile`   | `publicId, repoId, path, lang, hash, loc, displayName`     | a source file                    |
| `CodeSymbol` | `publicId, fileId, name, kind(func/class/export), span`    | a top-level symbol               |
| `CodePackage`| `publicId, name, version`                                  | a workspace/npm package          |

| Relationship   | From → To                | Meaning                                  |
|----------------|--------------------------|------------------------------------------|
| `CONTAINS`     | CodeRepo→CodeFile, CodeFile→CodeSymbol | structural containment     |
| `IMPORTS`      | CodeFile→CodeFile        | static import edge (resolved specifier)  |
| `REFERENCES`   | CodeSymbol→CodeSymbol    | symbol-level use                         |
| `DEPENDS_ON`   | CodePackage→CodePackage  | manifest dependency                      |
| `COVERED_BY`   | CodeFile→CodeFile        | source ↔ test mapping (reuses ADR-015 Vitest import-graph) |

All writes go through a new `code.graph.*` capability family (contract → handler →
`scopedSession()`), so they inherit org+workspace scoping, metering, and IAM — **never** raw
Cypher from the daemon. Edge inference that needs an LLM (e.g. semantic "this change affects
billing") rides the existing Inngest async path (`semantic.edge.infer`), not the hot loop.

### Blast radius

Blast radius of an edited file `F` = the **reverse transitive closure** over `IMPORTS` /
`REFERENCES` (who depends on `F`, directly and transitively), unioned with `COVERED_BY` to
surface impacted tests. Computed in-memory from the hot graph (BFS with a visited set, depth
cap + cycle guard), returned as ranked impacted files/symbols/tests with the path that
connects them. The same query is exposed as a `code.graph.blastRadius` capability so the API,
MCP, and cloud agents can ask it server-side against the synced graph — CLI↔MCP parity per
CLAUDE.md.

### Four-store routing (binding)

| Daemon data                                   | Store       | How                                                        |
|-----------------------------------------------|-------------|-----------------------------------------------------------|
| Code nodes/edges, blast-radius graph          | **Neo4j**   | `code.graph.*` via `invoke()` + `scopedSession()`         |
| Raw hook/edit events, tool-use, session rollups | **ClickHouse** | append-only `internal.agent_edit_events` (extends existing `internal.agent_executions`/`claude_sessions`) |
| Daemon registration, session rows, **sync cursors** | **Postgres** | ACID; cursor is the operational lock (per ADR-012)    |
| Proof artifacts (screenshots, test logs)      | **Blob**    | `@oxagen/storage`; reference row in Postgres              |

This is the **dual-write pattern of ADR-012 applied to local edits**: Postgres holds the sync
cursor (never lose your place), Neo4j is the retryable index, ClickHouse is observability.

### Sync model

- **Local-first.** Every query is answered from RAM; sync is asynchronous and never on the
  read path. The daemon is fully functional offline (planes, flaky wifi) and reconciles when
  connectivity returns.
- **Batched + cursor-tracked.** Edit events accumulate into a WAL; a debounced flusher pushes
  graph deltas (upsert nodes/edges) and event batches to the cloud, advancing the Postgres
  cursor only after Neo4j + ClickHouse writes ack — exactly ADR-012's recovery guarantee.
  Stale cloud nodes are possible (retryable); a lost cursor is not.
- **Scoped + authorized.** Sync targets the org+workspace bound in the CLI config; every push
  is an `invoke()` so IAM/entitlement gates apply. A workspace without the code-graph
  entitlement degrades to local-only.

## Alternatives considered

- **No daemon — run a scan per CLI invocation.** Re-parsing the tree on every `oxagen
  blast-radius` is seconds-slow and still blind to the *sequence* of edits within a session.
  Rejected: can't be "never out of date" without continuous observation.
- **Keep the fire-and-forget telemetry scripts and just query ClickHouse.** ClickHouse is
  append-only event analytics, not a graph — computing transitive closure there is the wrong
  tool, and it violates the four-store law (graph traversal belongs in Neo4j). The existing
  scripts stay as the *event* tributary; they cannot be the graph.
- **Fold code nodes into the existing product knowledge graph.** Simpler, but mixes code
  structure (high-churn, machine-derived) with curated product entities, pollutes semantic
  retrieval, and couples two very different lifecycles. The user chose a separate ontology.
- **TCP/HTTP local server (like apps/api).** Opens a port and an auth surface for what is a
  single-user, single-host concern. Unix socket + OS file permissions is strictly safer and
  simpler. Rejected.
- **Claude-Code-only hooks, no abstraction.** Faster now, but the stated goal is to run *our*
  agents and others off this. A one-envelope protocol with adapters costs little and avoids a
  rewrite. The user chose generic-protocol-first.
- **Persist the in-memory graph to SQLite locally instead of a WAL + cloud Neo4j.** Adds a
  fifth local store to keep consistent; the WAL (for crash recovery) + cloud Neo4j (for
  durability/sharing) already cover it. Revisit only if cold-start scan time hurts.

## Consequences

- A new `apps/cli/src/daemon/` subsystem ships with the CLI; `oxagen daemon start|stop|status|hook`
  commands are added (closing some of the `GAPS.md` parity items too).
- A new `code.graph.*` capability family (contracts + handlers + Neo4j schema migration for
  vector/btree indexes on `publicId`, `path`) — full contract→API→MCP→CLI parity.
- A new ClickHouse table `internal.agent_edit_events` (append-only, TTL'd like its siblings).
- The legacy CC telemetry scripts are **superseded** by the daemon's event stream and removed
  once the daemon path is verified in prod-equivalent env (don't run both writers long-term).
- **Security/tenancy:** socket is local-only (`0700`); all cloud writes go through `invoke()`
  so IAM/entitlement/metering hold; the daemon **must** call `bootstrapEntitlementRuntime()`
  at startup or it silently skips the entitlement gate (CLAUDE.md gotcha).
- **Privacy:** edits can contain secrets/PII. Events store path + hashes + line counts by
  default, **never file contents**, unless a workspace explicitly opts into content capture.
  This must be settled before any sync ships (see open questions).
- Unblocks the north star: with a current graph + blast radius + the kernel, the CLI can host
  Oxagen product-eng agents (`agent.subagent.dispatch`, `prompt.settings.*`) operating on a
  live model of the repo.

### Phased build plan

1. **P0 — Local spine.** `oxagen daemon start|status|stop` (detached, pidfile), Unix-socket
   hook server, the one Event envelope, WAL, in-memory graph from an initial repo scan +
   incremental edit application. No cloud. Ship `oxagen blast-radius <path>` answered locally.
   *Effort: L.*
2. **P1 — Claude Code adapter.** `oxagen daemon hook` shim + `.claude/settings.json` wiring;
   prove session.start→edits→session.end produces a correct live graph. Keep legacy scripts in
   parallel, compare. *Effort: M.*
3. **P2 — ClickHouse event sync.** `internal.agent_edit_events`, batched flusher, Postgres
   cursor. Retire `claude-telemetry-logger.ts` once parity is shown. *Effort: M.*
4. **P3 — Neo4j code graph + `code.graph.*` capabilities.** Contracts, handlers, scoped writes,
   server-side `code.graph.blastRadius`; CLI↔MCP↔API parity. *Effort: L.*
5. **P4 — Agents on the CLI.** Wire `agent.subagent.dispatch` + memory recall over the live
   code graph; first product-eng task driven end-to-end from `oxagen`. *Effort: XL.*

Each phase is a PR against `main` behind a `--experimental` flag until P3 lands.

### Open questions (to resolve before the phase they gate)

- **Content capture policy** (gates P2/P3): default to hashes + line-stats only; opt-in for
  content. Confirm the default and where the opt-in lives (workspace setting via
  `prompt.settings.*`-style contract?).
- **Symbol resolution depth** (gates P0/P3): file-level `IMPORTS` first (cheap, TS resolver),
  symbol-level `REFERENCES` later (needs a TS language service) — confirm P0 is file-level.
- **Multi-repo / monorepo identity** (gates P3): one `CodeRepo` per git remote vs per workspace
  package — propose per-remote with `CodePackage` overlay.
- **Daemon lifecycle ownership** (gates P0): per-user single daemon (multiple repos as
  `CodeRepo`s) vs per-repo daemon. Propose single per-user.

## References

- ADR-012 — Connector dual-write (Postgres cursor + Neo4j index): the recovery model reused here
- ADR-003 — Neo4j as vector store / graph
- ADR-010 — Subagent fanout via Inngest (async edge inference path)
- ADR-015 — Vitest import-graph (source↔test mapping reused for `COVERED_BY`)
- `packages/oxagen/src/kernel.ts`, `packages/handlers/src/register.ts`, `@oxagen/plugins` bootstrap
- `packages/agent/src/memory/neo4j.ts`, `packages/ontology/src/{client,tenant}.ts`
- `.claude/settings.json` (existing hooks), `tools/scripts/claude-telemetry-logger.ts`,
  `tools/scripts/sync-claude-telemetry.ts`, `tools/scripts/oxagen-run-record-edit.sh`,
  `tools/scripts/inngest-dev.ts` (detached-process lifecycle pattern)
- `apps/cli/src/lib/{config,api-client}.ts` (cloud auth), `apps/cli/GAPS.md`

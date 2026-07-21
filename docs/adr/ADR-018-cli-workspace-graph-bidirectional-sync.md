# ADR-018: CLI ↔ Workspace Graph Bidirectional Sync

> **Status: Superseded** by `docs/specs/workspace-graph-boundary/spec.md` (2026-07-20). The bidirectional CLI graph sync described here has been removed.

- **Status:** Accepted
- **Date:** 2026-06-27
- **Deciders:** Mac Anderson
- **Related:** ADR-012 (connector dual-write), ADR-016 (CLI daemon live code graph), [[no-drift-across-surfaces]], [[connector-dual-write-pattern]]

## Context

The `oxagen` CLI builds a **local code graph** — an in-memory, per-repo structural index (files → symbols → imports) used to enhance prompts (see ADR-016). It is ephemeral: rebuilt on each process/daemon start, never persisted, never synced anywhere.

The **workspace graph** is the platform's Neo4j knowledge graph surfaced in the web app. It holds a **business ontology** (entities + relationships, often connector-ingested) and may or may not contain the repo the coding agent is working in.

Today these are disconnected. We want them connected, **in both directions**, without coupling to any one vendor:

1. **Down** — pull a workspace-graph subgraph into a fast **local copy** so the agent (and `oxagen graph *`) answer graph questions without a network round-trip.
2. **Up** — push what the CLI learns back into the workspace graph:
   - **Code structure** — the repo's files/symbols/imports as a subgraph.
   - **Agent execution** — each session/turn/tool/file/model as a **lineage** subgraph (the `TurnTrace` telemetry, in graph form).

## Decision

A **single source of truth (the workspace graph) with a refreshable local read-replica, and idempotent, content-addressed up-flows.** No bespoke transport, no vendor lock.

### Storage-boundary placement (per the four-store model)

| Data | Store | Why |
|---|---|---|
| Workspace ontology + relationships | **Neo4j** (platform) | graph data — authoritative |
| Local projection of a workspace subgraph | **DuckDB** (CLI, embedded) | fast, vendor-neutral, single-file, offline |
| Repo code subgraph (files/symbols/imports) | **Neo4j** (platform), `is_system=true` | structural graph data; namespaced, linkable to ontology |
| Agent execution **lineage** (session→turn→tool→file→model) | **Neo4j** (platform), `is_system=true` | "workflow lineage, agent memory" is explicitly Neo4j |
| Raw execution **events** (per-turn tokens/cost/timing) | **ClickHouse** (platform) | append-only runtime telemetry — already where verbose telemetry analytics belong |

The local code graph stays in memory for live editing; only the **downloaded workspace projection** is persisted locally (DuckDB).

### Direction semantics

- **Workspace graph = source of truth.** The local DuckDB copy is a **read replica** — refreshable, never the merge authority. It carries a **sync cursor** (`updatedAt` high-watermark + node count) for incremental refresh.
- **Up-flows are idempotent events, not merges.** Everything the CLI pushes is **content-addressed** so re-sending is a no-op:
  - Code nodes keyed by `repo + path` (+ `contentHash`); symbols by `repo + path + symbol + signatureHash`.
  - Lineage nodes keyed by `sessionId / turnId / toolEventId` (already unique in the trace).
  - Deletes are **tombstones** (a delete event for a key), never "diff the whole graph."
- **No full-graph diffing, ever.** Code deltas come from **git** (`git diff <lastSyncedSHA>..HEAD`), re-extracting only changed files. This is the cheapest correct delta and is **git-native = vendor-neutral**: works with GitHub, GitLab, Gitea, or no remote at all. We deliberately do **not** depend on the GitHub connector for CLI-driven sync (it remains available for background full ingestion when a repo is connected — see ADR-012).

### Why git-native deltas over the GitHub connector

The GitHub connector is the *more* vendor-locked option (it ties sync to one host and a webhook pipeline). Git itself is the universal substrate every repo already has. Keying code nodes by commit SHA + content hash makes the up-sync:
- **resumable** — restart from the last synced SHA stored in the local cursor;
- **idempotent** — re-pushing the same SHA changes nothing;
- **host-agnostic** — no GitHub App, no webhook, no network dependency to *compute* the delta.

This mirrors the durability model in the fleet git-isolation work: content-addressed, replay-safe.

### Capability surface (contract → API → MCP → CLI, per the parity rule)

All flows go through Oxagen contracts (no side-channel endpoints):

| Capability | Dir | Purpose |
|---|---|---|
| `graph.export` | down | Paginated, cursor-aware read of a workspace subgraph (nodes + edges) for local projection. **(Slice 1 — this PR.)** |
| `graph.node.upsert` / `graph.edge.upsert` (existing) | up | Idempotent node/edge writes — reused for code + lineage pushes. |
| `graph.sync.push` | up | Batch envelope of content-addressed upserts + tombstones with a `source` (`code` \| `lineage`) and idempotency key. *(Slice 2/3.)* |

### Local store

A new **`GraphStore`** in `@oxagen/engram` (where the embedded DuckDB already lives — no new native dep, no drift) with `graph_nodes` + `graph_edges` tables and a `sync_cursor` row per `(org, workspace)`. The CLI's `queryCodeGraph` gains a workspace-projection backend so enhancement and `oxagen graph *` can read the local copy first.

## Rollout (slices)

1. **Down-sync + local store (this PR):** `graph.export` contract/handler/route/MCP + `@oxagen/engram` `GraphStore` + `oxagen graph pull` (incremental) and `oxagen graph status`. Read replica, cursor-based refresh.
2. **Up-sync code delta:** git-native delta → `graph.sync.push` with `source: code`; repo subgraph under `is_system=true`, keyed by repo+path+hash.
3. **Up-sync execution lineage:** project `TurnTrace` → session/turn/tool/file/model nodes + edges → `graph.sync.push` with `source: lineage`. Raw event rows continue to ClickHouse.
4. **Enhancement integration:** prompt-enhancer reads the local projection first, falling back to the live code graph; the platform subgraph augments local context (closing the gap noted in `prompt-enhancer.ts`).

## Consequences

**Positive:** offline-fast graph reads; the workspace graph gains code + execution lineage without GitHub coupling; idempotent/resumable sync; clean storage boundaries; everything reachable identically across API/MCP/CLI.

**Negative / risks:** the local copy can be stale (mitigated by cursor refresh + a `status` command showing drift); a large workspace graph is costly to fully mirror (mitigated by label/scope filters on `graph.export` and incremental pulls); tenant isolation on export is critical (every Cypher filters `orgId` **and** `workspaceId`, per existing graph handlers).

**Neutral:** local store is a *projection*, not authoritative; losing it costs only a re-pull.

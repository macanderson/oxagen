# ADR-018: CLI ↔ Workspace Graph Bidirectional Sync

- **Status:** Superseded — both down-sync and up-sync revoked
- **Date:** 2026-06-27
- **Deciders:** Mac Anderson
- **Related:** ADR-012 (connector dual-write), ADR-016 (CLI daemon live code graph), `docs/specs/workspace-graph-boundary/spec.md`, [[no-drift-across-surfaces]], [[connector-dual-write-pattern]]

> **Supersession note (2026-07-21):** No synchronization direction in this ADR
> remains approved. `graph.export`, CLI graph pull/status, and the local
> workspace DuckDB replica are retired with the generic CLI→cloud mutation
> paths. A bulk graph dump cannot guarantee convergence for tombstones,
> deletions, or authorization revocations on intermittently connected clients.
> The exact checkout graph stays local. Shared context is read through bounded,
> online, RBAC-scoped capabilities; canonical shared code topology comes from
> verified provider snapshots. Exact run evidence belongs in a separate, narrow
> evidence-ledger ingest path. The body below is retained only as rejected
> decision history and must not be built.

## Historical context (superseded)

The `oxagen` CLI builds a **local code graph** — an in-memory, per-repo structural index (files → symbols → imports) used to enhance prompts (see ADR-016). It is ephemeral: rebuilt on each process/daemon start, never persisted, never synced anywhere.

The **workspace graph** is the platform's Neo4j knowledge graph surfaced in the web app. It holds a **business ontology** (entities + relationships, often connector-ingested) and may or may not contain the repo the coding agent is working in.

Today these are disconnected. We want them connected, **in both directions**, without coupling to any one vendor:

1. **Down** — pull a workspace-graph subgraph into a fast **local copy** so the agent (and `oxagen graph *`) answer graph questions without a network round-trip.
2. **Up** — push what the CLI learns back into the workspace graph:
   - **Code structure** — the repo's files/symbols/imports as a subgraph.
   - **Agent execution** — each session/turn/tool/file/model as a **lineage** subgraph (the `TurnTrace` telemetry, in graph form).

## Historical decision (superseded)

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
| `graph.node.upsert` / `graph.edge.upsert` (existing) | up | **Superseded for CLI code/lineage upload.** These general graph mutations are not a code-evidence transport. |
| `graph.sync.push` | up | **Revoked.** The generic client-authored code/lineage mutation surface is retired. |

### Local store

A new **`GraphStore`** in `@oxagen/engram` (where the embedded DuckDB already lives — no new native dep, no drift) with `graph_nodes` + `graph_edges` tables and a `sync_cursor` row per `(org, workspace)`. The CLI's `queryCodeGraph` gains a workspace-projection backend so enhancement and `oxagen graph *` can read the local copy first.

## Historical rollout (superseded)

1. **Down-sync + local store — revoked:** the export capability, pull/status commands, cursor, and workspace replica are retired.
2. **Up-sync code delta — revoked:** the checkout graph remains local; canonical shared topology is projected from a verified provider commit.
3. **Up-sync execution lineage — revoked:** generic graph mutation is not the run-evidence path. A future narrow evidence-ledger ingest requires its own contract and trust model.
4. **Enhancement integration — revoked:** the agent must not read a downloaded workspace projection. Any cloud context is retrieved explicitly through the online authorization boundary.

## Historical consequences (superseded)

**Former benefit:** offline-fast workspace-graph reads through a refreshable local replica.

**Disqualifying risks:** cursor refresh does not carry complete tombstone, deletion, or grant-revocation semantics; an offline copy can retain data after the principal is no longer authorized; and bulk export materially expands the exfiltration surface. Label filters and freshness indicators do not solve those failures.

**Replacement boundary:** keep checkout-local code and memory local; query shared workspace context online under current grants; derive shared repository topology only from verified canonical provider state; ingest run evidence only through a typed, narrow, replayable contract.

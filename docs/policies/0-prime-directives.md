# Prime Directives and Oxagen Rules

The foundational, non-negotiable layer of the policy: hard constraints, prime directives, and Oxagen project-specific rules. Read this first.

## 0. Non-Negotiables

These are absolute. They are never traded away, deferred to a later PR, or relaxed under deadline pressure. A change that violates any of these does not merge, full stop. When one blocks the path, halt and surface the conflict; never work around it.

- **Compliance from day one.** The system is SOC 2 compliant at all times, never retrofitted. Architecture and data handling also meet PCI DSS, GDPR, and HIPAA standards. Every design decision is made as if an auditor is reading it.
- **Encryption at rest, always.** All persisted data is encrypted at rest with no exceptions. Secrets are never committed, logged, or stored in plaintext.
- **Strict types everywhere. No exceptions.** No `any`, no implicit `any`, no untyped boundaries, no `# type: ignore` without a justification comment and a tracking issue. Every function signature, return value, and public surface is fully typed.
- **Zero warnings, zero errors, ever.** Linters, type checkers, compilers, and test runners are all green. A warning is treated as an error. A PR with any warning or error does not merge.
- **Pinned versions.** All dependency versions are pinned exactly for reproducible builds. No floating ranges that let an install drift.
- **Logging everywhere it makes sense,** at the appropriate level, plus full instrumentation through the shared analytics package (Section 9).
- **Thin wrappers only.** API, CLI, and MCP services are thin shells over shared packages. Business logic lives in `packages/`, never reproduced in a service. (Section 7.)
- **Domain-layer organization, always.** Never a flat `models/` or `routes/` folder. (Section 7.)
- **Versioned API.** Every endpoint is versioned. (Section 7.)
- **Mobile-first.** Thumb-navigable interfaces outrank desktop. (Section 9.)

## 0.5 Prime Directives

- Move the rock forward. Every PR lands a complete, working vertical slice. No placeholders, no `TODO` stubs, no `raise NotImplementedError`, no commented-out scaffolding left for "later."
- Finish what you touch. If a change spans schema, API, frontend, tests, and docs, all layers ship together in the same PR or the PR does not merge.
- No drift. These policies are not suggestions you can trade away under time pressure. If you cannot satisfy a policy, halt and report why, then propose the smallest compliant alternative.
- Prefer deleting code to adding it. The best PR removes more than it adds while delivering the same capability.

## Oxagen Rules

Project-specific rules for Oxagen. These extend the Agent Coding Policy and are binding in the same way. Where a general policy and an Oxagen rule both apply, the stricter wins.

## Data Storage

We run four stores, each with one clear job. Pick the store by the nature of the data, not by convenience. Do not spread one concern across stores, and do not invent a fifth.

### The Stores and Their Jobs

- **Postgres (AlloyDB)** — the system of record for everything the application needs to function. Tenants, workspaces, projects, memberships, connections, auth, billing, configuration, and all transactional, relational, and operational state live here. If the app cannot boot or serve a request without the data, it lives in Postgres. Postgres is also the relational and vector store.
- **Neo4j** — the knowledge graph and the home of agent cognition. All agent memory, observations, lessons learned, and the history of execution runs live here. This is the portable, customer-owned intelligence layer. Lean on the graph; this is the product's differentiator.
- **ClickHouse** — analytics and high-volume telemetry. Event streams, metrics, instrumentation output (per the shared analytics package), and any append-heavy, aggregate-query workload. ClickHouse is for analyzing what happened at scale, never the source of truth for app function.
- **File storage** — large binary and blob artifacts: uploads, generated documents, model artifacts, exports, attachments. Anything that is a file, not a row or a node. Store the blob here and a reference to it in Postgres.

### Neo4j: Agent Memory and Run History

- Neo4j holds all agent memory, observations, and execution-run history. This is by design: agents query the graph for context, and the graph is where reasoning, lessons, and run lineage accumulate.
- Treat the graph as the primary surface for this data. Do not pre-emptively copy it elsewhere "to be safe."
- **Mirror to Postgres only when genuinely necessary, and justify it in the SPEC.** A mirror is warranted only when there is a hard requirement the graph cannot serve, for example a transactional consistency guarantee or a relational query that must join graph data with operational data at request latency. Absent that, do not mirror.
- **Avoid dual-write scenarios.** Never write the same fact to two stores in the same operation as a default pattern. Dual writes create drift, double the failure modes, and break the single-source principle. If a mirror is truly required, drive it from a single authoritative write via an explicit, idempotent, one-directional projection (Postgres derived from Neo4j, or the reverse), never two independent writes.

### Bring-Your-Own-Knowledge-Graph

We design for customers who bring their own knowledge graph. This shapes a hard boundary:

- **Neo4j must never hold transactional data that the application requires to function.** If swapping the customer's graph in or out would break the app, that data is in the wrong store. It belongs in Postgres.
- Neo4j holds **only truly customer-portable information**: agent memory, observations, lessons, and run history that the customer owns and can carry to their own graph. It is the customer's intelligence, not our plumbing.
- The app keeps running with an empty or externally-provided graph. Graph content is enriching context, never a load-bearing dependency for core operation.
- Access the graph through the shared adapter seam (vendor-neutrality, Agent Coding Policy Section 2) so a customer-supplied graph drops in at one boundary.

### Decision Rule

When placing a new piece of data, ask in order:

1. Is it a file or blob? → File storage, reference in Postgres.
2. Is it required for the app to function, transactional, or relational app state? → Postgres.
3. Is it agent memory, an observation, a lesson, or run history that a customer would own and carry away? → Neo4j.
4. Is it high-volume telemetry or analytics for aggregate querying? → ClickHouse.

If a datum seems to want two stores, it is probably modeled wrong. Resolve the ambiguity before writing, and never settle it with a dual write.

## SQL Conventions

These extend the general naming standard. Follow `snake_case`, singular table names, and the Postgres-default constraint suffixes throughout. The rules below are Oxagen-specific and binding.

### Identifiers: UUID `id` plus user-friendly `public_id`

- Every table's primary key is a UUID `id` column. This stays the internal, opaque, immutable key used for all foreign keys and joins. Workspaces and orgs already do this correctly; keep it.
- Wherever a row is referenced by a human or exposed in a URL, API path, or UI, add a `public_id`: a user-friendly, URL-safe slug. Workspaces and orgs already carry this concept; extend it to every entity where a readable handle makes sense.
- The `public_id` is what appears in customer-facing surfaces and `/v1` routes. The UUID `id` is never exposed where a `public_id` exists.
- `public_id` is unique within its tenant scope, stable once assigned, and validated against a strict slug pattern. Internal joins and foreign keys always use `id`, never `public_id`.
- Not every table needs a `public_id`. Pure join tables, append-only event tables, and rows never addressed by a human do not get one. Add it only where something or someone looks the row up by name.

### Soft Delete: Only Where It Earns Its Place

- Soft delete (`deleted_at`, and the related lifecycle columns) belongs only on tables where a row can be meaningfully retired while preserving referential history and the app must hide rather than destroy it.
- **Append-only and audit tables never get soft delete.** They also do not get `updated_at`, `updated_by_user_id`, or any mutation-tracking column. An append-only row is written once and never changes; tracking mutation on it is dead weight and a false signal that it can change.
- Match the column set to the table's nature:
  - **Mutable entity tables:** `id`, `public_id` (where applicable), `created_at`, `created_by_user_id`, `updated_at`, `updated_by_user_id`, and `deleted_at` if soft delete applies.
  - **Append-only / audit / event tables:** `id`, `created_at`, and `created_by_user_id` only. No `updated_*`, no `deleted_at`. Correcting the record means appending a new row, never mutating or soft-deleting an existing one.
- Do not add lifecycle columns reflexively. Adding `updated_at` to a table that is never updated, or `deleted_at` to an immutable log, is schema bloat (Agent Coding Policy Section 4) and is rejected in review.

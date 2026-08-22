# `docs/`

Long-lived documentation for the Oxagen v2 monorepo. Code-level comments
stay in the code; this directory is for the *durable* explanations that
describe how the platform is shaped, what was decided and why, what's
planned, and how to operate it.

## Layout

```
docs/
├── README.md                ← you are here
├── VISION.md                 product north star (metered/governed/graph-grounded control plane)
├── adr/                      architectural decision records
├── audits/                   committed audit reports
├── brand/                    brand assets
├── capabilities/             contract surface documentation (per-capability)
├── compliance/                SOC 2 / compliance references
├── erd/                       entity-relationship diagrams
├── guides/                    how-to guides
├── ops/                       operational runbooks
├── queries/                   canonical SQL / Cypher / ClickHouse queries
├── reference/                  generated-artifact-shaped reference docs
├── site/                       static marketing/reference page(s)
├── specs/                      per-topic spec.md / plan.md (the actual home of
│                                design specs — see below)
├── superpowers/                 plans/specs (candidate for folding into specs/)
├── CODEMAPS/                    generated architecture codemaps
└── health-checks.md             draft (unfinished)
```

### `adr/` — Architectural Decision Records

One-shot decisions captured with their reasoning. Format: short markdown
describing the decision, the context that produced it, alternatives
considered, and the consequences. ADRs are **immutable once accepted** —
when a decision is overturned, a new ADR is written that supersedes the
old one. See [`adr/README.md`](adr/README.md) for the full index.

Use ADRs to record decisions like "we chose X over Y because Z." Use the
`specs/` folder for the durable design intent that ADRs feed into.

### `specs/` — Specs and plans

Each topic lives in its own folder under `specs/`, typically with:

| File | Purpose |
|---|---|
| `spec.md` | **What** we're building, **why**, the constraints. Product + design + engineering align here. Updated when scope changes. |
| `plan.md` | **How** we'll build it. Sequenced work, dependencies, milestones. Lives until implementation is complete, then archived. |

Current topics (non-exhaustive — `ls docs/specs/` for the full, growing list):

| Topic | Status |
|---|---|
| [`specs/information-architecture/`](specs/information-architecture/spec.md) | Spec'd |
| [`specs/application-shell/`](specs/application-shell/spec.md) | Spec'd |
| [`specs/command-menu/`](specs/command-menu/spec.md) | Spec'd |
| [`specs/iam/`](specs/iam/plan.md) | Spec'd |

A number of specs describe features that have since shipped but carry no
"Shipped"/"Archived" status header at the file itself — treat `apps/docs`'
specs-and-plans section as the more current shipped/partial verdict until
each spec is stamped or moved to an archive.

### `capabilities/` — Contract surface docs

Per-capability reference documentation generated from (and consistent
with) the contract registry in `@oxagen/oxagen`. Each capability gets
a stable URL that the audit log, the access matrix, and customer
support escalations can deep-link to. When a contract ships, it gets a
markdown counterpart here. See [`capabilities/_index.md`](capabilities/_index.md).

### `queries/` — Canonical queries

The "official" version of frequently-needed read queries. Currently a flat
directory (`docs/queries/*.sql`) rather than the per-store subfolder
structure below — adopt the subfolders as more queries are added, or treat
this section as aspirational:

- `queries/postgres/` — Drizzle-shape SQL for one-off reports
- `queries/clickhouse/` — audit log + telemetry analysis queries
- `queries/neo4j/` — Cypher patterns for ontology traversal

Used as source-of-truth references when ad-hoc queries are needed; also
the seed corpus for the AI agent's query suggestions.

## When to write what

| You want to … | Write a … |
|---|---|
| Capture *why* a decision was made and what was rejected | `adr/ADR-NNN-title.md` |
| Define a new system or surface and how it should be built | `specs/<topic>/spec.md` + `plan.md` |
| Document a contract for users and integrators | `capabilities/<capability-name>.md` |
| Share a canonical query pattern | `queries/<purpose>.sql` |

## Editing rules

- Keep all docs in Markdown. No Word / Notion exports in the repo.
- Treat `spec.md` as a published interface. Substantive changes go
  through review.
- Update docs in the same PR as the code change that motivates them.
- ADRs append; specs evolve. Never edit a past ADR's body — write a new
  one that supersedes it.
- The architecture and IAM specs are the **single source of truth** for
  product/IA decisions. If something contradicts them in code, the code
  is wrong (or the spec needs a versioned update).

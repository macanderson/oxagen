# `docs/`

Long-lived documentation for the Oxagen v2 monorepo. Code-level comments
stay in the code; this directory is for the *durable* explanations that
describe how the platform is shaped, what was decided and why, what's
planned, and how to operate it.

## Layout

```
docs/
├── README.md                ← you are here
├── adr/                     architectural decision records
├── architecture/            long-lived design specs + implementation plans
├── capabilities/            contract surface documentation (per-capability)
├── epics/                   product epics with acceptance criteria
└── queries/                 canonical SQL / Cypher / ClickHouse queries
```

### `adr/` — Architectural Decision Records

One-shot decisions captured with their reasoning. Format: short markdown
describing the decision, the context that produced it, alternatives
considered, and the consequences. ADRs are **immutable once accepted** —
when a decision is overturned, a new ADR is written that supersedes the
old one.

Use ADRs to record decisions like "we chose X over Y because Z." Use the
architecture/ folder for the durable design intent that ADRs feed into.

### `architecture/` — Specs and plans

Each architectural topic lives in its own folder under `architecture/`,
with two files:

| File | Purpose |
|---|---|
| `spec.md` | **What** we're building, **why**, the constraints. Product + design + engineering align here. Updated when scope changes. |
| `plan.md` | **How** we'll build it. Sequenced work, dependencies, milestones. Lives until implementation is complete, then archived. |

Full convention is documented in [`architecture/README.md`](architecture/README.md).

Current topics:

| Topic | Status |
|---|---|
| [`architecture/information-architecture/`](architecture/information-architecture/spec.md) | Spec'd |
| [`architecture/application-shell/`](architecture/application-shell/spec.md) | Spec'd |
| [`architecture/command-menu/`](architecture/command-menu/spec.md) | Spec'd |
| [`architecture/iam/`](architecture/iam/plan.md) | Spec'd in IA · Wave 1 plan ready · OXA-1388/1389/1390 created |

### `capabilities/` — Contract surface docs

Per-capability reference documentation generated from (and consistent
with) the contract registry in `@oxagen/oxagen`. Each capability gets
a stable URL that the audit log, the access matrix, and customer
support escalations can deep-link to. When a contract ships, it gets a
markdown counterpart here.

### `epics/` — Product epics

Discrete chunks of product work with acceptance criteria. One folder per
epic. Epics describe *delivery* — the spec/plan in `architecture/`
describes the *design*. Epics often reference architecture docs and
ADRs; they're not a duplicate place to design.

### `queries/` — Canonical queries

The "official" version of frequently-needed read queries for each store:

- `queries/postgres/` — Drizzle-shape SQL for one-off reports
- `queries/clickhouse/` — audit log + telemetry analysis queries
- `queries/neo4j/` — Cypher patterns for ontology traversal

Used as source-of-truth references when ad-hoc queries are needed; also
the seed corpus for the AI agent's query suggestions.

## When to write what

| You want to … | Write a … |
|---|---|
| Capture *why* a decision was made and what was rejected | `adr/NNNN-title.md` |
| Define a new system or surface and how it should be built | `architecture/<topic>/spec.md` + `plan.md` |
| Document a contract for users and integrators | `capabilities/<contract-id>.md` |
| Track a delivery milestone with acceptance criteria | `epics/<epic-name>/` |
| Share a canonical query pattern | `queries/<store>/<purpose>.sql` |

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

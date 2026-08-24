# Oxagen Platform

A metered, governed, graph-grounded control plane for teams that build and resell AI agents.

<p align="center">
  <a href="https://github.com/macanderson/oxagen/actions/workflows/pipeline.yml">
    <img alt="CI Status" src="https://github.com/macanderson/oxagen/actions/workflows/pipeline.yml/badge.svg?branch=main" />
  </a>
  <a href="https://github.com/macanderson/oxagen/actions/workflows/vision-gate.yml">
    <img alt="Vision Gate" src="https://github.com/macanderson/oxagen/actions/workflows/vision-gate.yml/badge.svg?branch=main" />
  </a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-6.x-3178C6?logo=typescript" />
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-24%20LTS-339933?logo=node.js" />
  <img alt="Next.js" src="https://img.shields.io/badge/Next.js-16-000000?logo=next.js" />
  <img alt="PostgreSQL" src="https://img.shields.io/badge/PostgreSQL-16+-336791?logo=postgresql" />
  <img alt="Neo4j" src="https://img.shields.io/badge/Neo4j-5.x-008CC1?logo=neo4j" />
  <img alt="ClickHouse" src="https://img.shields.io/badge/ClickHouse-append--only-FFCC01?logo=clickhouse" />
  <img alt="License" src="https://img.shields.io/badge/License-Proprietary-red.svg" />
</p>

> [Vision](docs/VISION.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Support](SUPPORT.md) · [Agents Guide](AGENTS.md) · [Telemetry](TELEMETRY.md)

---

## What It Does

Oxagen combines three concerns that agent frameworks, observability tools, and RAG stacks each handle separately:

1. **Governance** — every capability is a typed contract with IAM and entitlement enforcement, exposed with parity across API, MCP, CLI, and UI. There is no ungoverned tool surface; MCP tools are schema-enforced and metered.
2. **Grounding** — a Neo4j knowledge graph plus ontology grounds agent answers in cited, time-aware context.
3. **Monetization** — a ClickHouse→Stripe loop turns observed agent usage into customer billing, so teams reselling agents can meter usage and invoice their own customers.

The platform is vendor-neutral: bring your own model keys and your own Neo4j endpoint.

The full positioning and drift tests live in [`docs/VISION.md`](docs/VISION.md). CI enforces it via the **Vision Gate** ([`vision-gate.yml`](.github/workflows/vision-gate.yml), `pnpm check:vision`), which LLM-judges every PR diff against the vision and posts an advisory verdict.

```mermaid
graph LR
    A["Agent / customer action"] --> B["invoke() capability kernel"]
    B --> C["Typed contract (Zod schema)"]
    C --> D["IAM gate"]
    D --> E["Entitlement gate"]
    E --> F["Billing admission"]
    F --> G["Handler"]
    G --> H["ClickHouse usage events"]
    H --> I["Stripe meters → invoices"]
    G --> J["Neo4j lineage + citations"]
```

---

## How It Works

### The capability kernel

Every feature is a **capability**: a snake_case name (`send_message`, `run_workflow`, `suggest_semantic_edges`) declared once as a typed contract in `packages/oxagen/src/contracts/` and dispatched through a single `invoke()` path. The kernel injects three gates on every call — IAM policy resolution, plugin entitlement, and billing admission — and emits metering and lineage as a side effect of execution.

Capabilities are exposed with parity across four surfaces: the REST API (`apps/api`), the MCP server (`apps/mcp`), the CLI (`apps/cli`), and the web app (`apps/app`). `pnpm check:manifest` verifies the parity.

```mermaid
graph TB
    A["packages/oxagen — typed capability contracts (source of truth)"]

    B["REST API — apps/api · Hono"]
    C["MCP Server — apps/mcp · streamable HTTP"]
    D["Web App — apps/app · Next.js RSC"]
    E["CLI — apps/cli · Commander + Ink"]

    A --> B
    A --> C
    A --> D
    A --> E

    F["pnpm check:manifest — parity enforced in CI"]
    B -.-> F
    C -.-> F
    D -.-> F
    E -.-> F
```

### The metering→billing loop

Every `invoke()` call, agent step, and LLM call (all LLM traffic goes through `@oxagen/ai`, never raw SDK imports) emits usage events into ClickHouse: org, workspace, user, run, model, tokens, duration, surface. Those events price against Stripe meters (`pnpm billing:stripe-sync`), so a team reselling agents can meter observed usage and bill their customers. Fan-out primitives (`agent.subagent.dispatch` / `agent.subagent.aggregate`) carry the same discipline into fleets: every subagent step emits typed lineage plus cost.

### The knowledge graph

Connectors ingest fragmented sources (SaaS apps, databases, documents, events) through a universal pipeline into a per-workspace Neo4j graph governed by an ontology. Agents query it through governed capabilities (`ontology.query`, `ontology.neighbors`) and answer with citations to nodes and edges carrying time-aware validity, inspectable in the UI down to the property bag. Ingestion dual-writes: Postgres holds the operational record (sync cursors, connection health), Neo4j holds the graph index, ClickHouse observes the telemetry.

### Vendor neutrality

Model resolution goes through `modelIdOf()` and an AI gateway — no hard-coded vendor slugs. Customers bring their own model keys and their own Neo4j endpoint. No feature may couple the platform to a single cloud or model vendor where a neutral abstraction exists; the Vision Gate flags it as drift.

---

## Monorepo Layout

```
oxagen-platform/
├── apps/
│   ├── api          REST API + Inngest handler (Hono) — api.oxagen.sh
│   ├── app          Next.js web app (App Router, RSC) — app.oxagen.sh
│   ├── mcp          MCP server (streamable HTTP at /mcp) — mcp.oxagen.sh
│   ├── cli          Developer CLI + coding agent (Commander + Ink)
│   ├── docs         Documentation site (Fumadocs) — docs.oxagen.sh
│   ├── schemas      JSON Schema hosting, generated from Zod — schemas.oxagen.sh
│   └── web          Public website — oxagen.sh
│
├── packages/
│   ├── oxagen       Capability kernel, contracts, IAM resolution (source of truth)
│   ├── handlers     Built-in capability handler implementations
│   ├── agent        Agent runtime & tool dispatch
│   ├── agent-engine Agent execution engine (planning, steps, fleet coordination)
│   ├── ai           LLM access layer — all model calls go through here (metered)
│   ├── billing      Credit gate, usage metering, Stripe meter/ledger sync
│   ├── database     Drizzle schemas + Atlas migrations (Postgres)
│   ├── ontology     Neo4j schema, indexes, graph query layer
│   ├── telemetry    ClickHouse client + event schemas
│   ├── tenancy      Tenant scoping (RLS seam) — withTenantDb / runInTenantScope
│   ├── iam          Roles, permissions, policy seeds
│   ├── auth         Better Auth integration
│   ├── plugins      Plugin registry + entitlement gating
│   ├── ingestion    Universal connector pipeline
│   ├── inngest-functions  Durable background jobs
│   ├── ui           Component system (@oxagen/ui)
│   └── …            code-graph, compliance, config, crypto, engram, functions,
│                    github, mcp-config, notifications, prompt-templates,
│                    sandbox, skills, storage, and more
│
├── tools/scripts    Dev orchestration, CI checks (manifest, vision gate)
└── docs/            VISION.md, capability registry, ADRs, architecture
```

---

## Four-Store Architecture

Storage boundaries are enforced (see [`AGENTS.md`](AGENTS.md) and `docs/adr/`):

| Store | Holds | Never holds |
|---|---|---|
| **PostgreSQL** | Transactional state: users, orgs, IAM, billing, configs, job metadata | Analytics, graph relationships |
| **Neo4j** | Graph data: ontology entities, relationships, workflow lineage, agent memory | Transactional state, counters |
| **ClickHouse** | Append-only runtime events: usage, logs, metrics, traces, token analytics | Mutable state, graph data |
| **Blob storage** | Binary assets (reference row lives in Postgres) | — |

Tenant isolation is enforced at every layer: Postgres RLS (raw `db()` is banned — `withTenantDb` / `withSystemDb` / `scopedSession` only), ClickHouse predicates, per-workspace Neo4j scoping.

---

## Getting Started

### Prerequisites

- **Node.js** 24+ LTS (`node -v`)
- **pnpm** 11+ (`npm i -g pnpm`) — the repo pins `pnpm@11.7.0` via `packageManager`
- **Docker** (local Postgres :5433, Neo4j :7687, ClickHouse :8123)

### Setup

```bash
git clone https://github.com/macanderson/oxagen.git
cd oxagen-platform

cp .env.example .env.local    # fill in required values
pnpm install
pnpm env:check                # validate .env.local against the env registry

pnpm dev                      # Docker + migrations + all apps
```

Open `http://localhost:3000`. When you're done: `pnpm kill` (add `-- --volumes` for a full reset).

### Access Points

| Surface | Local | Production |
|---|---|---|
| **Web App** | `http://localhost:3000` | `https://app.oxagen.sh` |
| **API** | `http://localhost:4000` | `https://api.oxagen.sh` |
| **MCP** | `http://localhost:4100/mcp` | `https://mcp.oxagen.sh/mcp` |
| **Docs** | `http://localhost:3300` | `https://docs.oxagen.sh` |

MCP connects over streamable HTTP; org + workspace scope is carried by the API key.

---

## The `oxagen` CLI

Running `oxagen` with no args opens an interactive TUI (`OXAGEN_NO_TUI=1` or any subcommand/pipe keeps classic behavior). Install from the working tree with live rebuilds:

```bash
pnpm cli:dev          # build → install `oxagen` to PATH → watch + auto-rebuild
pnpm cli:install      # one-shot install, no watcher
```

```bash
oxagen --help
oxagen login                    # browser OAuth + PKCE; oxagen logout to clear the session
oxagen "summarize this repo"    # one-shot agent prompt (omit the prompt for the interactive TUI)
```

The CLI supports a local BYOK mode (no platform login) via `AI_GATEWAY_API_KEY` or `ANTHROPIC_API_KEY`. It collects anonymous, allowlist-validated usage telemetry — see [`TELEMETRY.md`](TELEMETRY.md) for the disclosure and one-command opt-out. Full command reference: [`apps/cli/README.md`](apps/cli/README.md).

---

## Development Workflow

`main` is a shared branch worked in parallel by multiple humans and agents. **Never commit or push directly to `main`.**

```bash
git fetch origin                                # sync first
git switch main && git rebase origin/main       # if origin/main is ahead
git switch -c feat/<slug>                       # cut your branch
git push -u origin feat/<slug>                  # push it immediately
# … commit small, push often, open a PR (draft early is fine) …
pnpm gate                                       # full local gate before marking ready
gh run watch                                    # confirm CI green
```

### The gate

`pnpm gate` runs the same checks as CI: ESLint (zero warnings) → TypeScript (strict, no `any`) → unit tests (coverage ratchets, capped at 90) → build → `check:manifest` (API↔MCP parity) → `check:contracts` → env check → migration lint. CI additionally runs the **Vision Gate**, which judges the PR diff against [`docs/VISION.md`](docs/VISION.md).

### Quality rules

- **New code requires new tests.** Coverage thresholds are ratchets — they only go up.
- **New user-facing flows require E2E tests** in `apps/app/e2e/` with screenshots of success states.
- **New capabilities require the full parity stack**: contract → API route → MCP tool → CLI command → docs. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the step-by-step.
- **Nothing merges unverified.** Always include proof: test output, CI status, or a rendered result.

---

## Documentation

| Resource | Path |
|---|---|
| **Vision & positioning** | [`docs/VISION.md`](docs/VISION.md) |
| **Capability registry** | [`docs/capabilities/`](docs/capabilities/) |
| **Architecture & ADRs** | [`docs/adr/`](docs/adr/) |
| **Agent/contributor architecture guide** | [`AGENTS.md`](AGENTS.md) |
| **Database schemas** | [`packages/database/`](packages/database/) |
| **API routes** | [`apps/api/src/routes/v1/`](apps/api/src/routes/v1/) |
| **MCP tools** | [`apps/mcp/src/tools/`](apps/mcp/src/tools/) |
| **CLI telemetry disclosure** | [`TELEMETRY.md`](TELEMETRY.md) |

---

## Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| **Frontend** | Next.js 16 + React 19 | App Router, streaming RSC, Turbopack |
| **API** | Hono | Type-safe routes |
| **AI** | Vercel AI SDK via `@oxagen/ai` | Streaming, structured output, metered + vendor-neutral |
| **Transactional DB** | PostgreSQL 16 | ACID, RLS, Drizzle + Atlas migrations |
| **Graph** | Neo4j 5+ | Ontology, lineage, vectors, time-aware facts |
| **Analytics** | ClickHouse | Append-only usage events → Stripe meters |
| **Billing** | Stripe | Meters, ledgers, customer invoicing |
| **Jobs** | Inngest | Durable workflows, retries, scheduling |
| **Auth** | Better Auth | Passkeys, OAuth, org/workspace RBAC |
| **Storage** | Vercel Blob via `@oxagen/storage` | Signed URLs, Postgres reference rows |
| **Language** | TypeScript 6 | Strict mode, no `any` |
| **Testing** | Vitest + Playwright | Unit + browser E2E |

---

## Deployment

Everything ships to AWS account `578673726240` on merge to `main`, from the
`deploy-web` and `deploy-node` jobs at the bottom of
`.github/workflows/pipeline.yml`. There is no hosting dashboard in the path and
no stored AWS key.

This replaced Vercel, whose account was suspended over an unpaid balance —
every site behind it answers `402`. Vercel is not a fallback and nothing here
may depend on it.

| App | Where it runs | Hostname |
| --- | --- | --- |
| `apps/web` | S3 + CloudFront | `oxagen.sh` |
| `apps/docs` | Node on the shared instance | `docs.oxagen.sh` |
| `apps/app` | Node on the shared instance | `app.oxagen.sh` |
| `apps/api` | Node on the shared instance | `api.oxagen.sh` |
| `apps/mcp` | Node on the shared instance | `mcp.oxagen.sh` |

Four of the five are processes on one EC2 instance rather than functions,
because three of them reach Postgres, Neo4j and ClickHouse over `127.0.0.1`.
Those ports are bound to loopback and the security group opens nothing to them,
so a VPC-attached Lambda would need a NAT gateway costing more per month than
everything else in this account combined. Caddy on the instance terminates TLS
and routes by hostname.

### Packaging

`tools/scripts/package-for-node.sh <service>` builds one app and lays it out as
an artifact, writing `dist-deploy/<service>/oxagen-run.json` — the manifest the
instance reads to learn which image to start, on which port, with which command,
and where to read its configuration. The four services are packaged in genuinely
different ways (Next standalone, an esbuild bundle, an xmcp bundle plus a
`pnpm deploy` install), and that script is where the differences are readable
next to each other.

Run it locally the same way CI does:

```bash
tools/scripts/package-for-node.sh api
```

### Four things that will bite

- **The instance is `arm64`** (a `t4g.medium`). `deploy-node` runs on
  `ubuntu-24.04-arm` for that reason. An artifact built on an x86 runner
  installs and tests green and then fails to load a native module at first
  request.
- **`STANDALONE=1` is required for the Next apps.** `apps/docs` and `apps/app`
  emit `output: standalone` only under that flag. Without it there is no
  `.next/standalone` and nothing to package.
- **`environment: production` is load-bearing.** Both deploy jobs exchange a
  GitHub OIDC token for a session on `gha-deploy-oxagen-platform`, which trusts
  exactly `repo:macanderson/oxagen:environment:production`. Removing the
  line breaks the deploy rather than loosening it.
- **`deploy-web` syncs with `--delete`.** This repository is the source of truth
  for that bucket. Anything added to it out of band is removed on the next
  merge.

### Configuration and secrets

Runtime configuration comes from Parameter Store under `/oxagen/production/`,
read by the instance when the container starts — not baked into the artifact, so
rotating a secret is a parameter write plus a restart rather than a rebuild, and
no secret rides in a tarball built by CI. `apps/docs` is given no prefix at all:
it renders MDX and holds no credentials.

`NEXT_PUBLIC_*` values are the exception. They are compiled into the client
bundle, so they are build inputs and are set in the workflow. Only the three
hostnames are set today; PostHog, the Stripe publishable key and Google Maps are
not wired, and those features degrade until they are.

### Rollback

The instance keeps the last three releases per service. If a new one does not
answer its health check within 60 seconds, the container and the `current`
symlink go back to the previous release — and the job still fails, so a merge
that boots red shows up red rather than quietly serving old code. Deploys are
serialized (`max-parallel: 1`) because all four land on the same 4 GB instance,
alongside the three databases.

The infrastructure, the node-side script and the `oxagen-run.json` contract live
in the `oxagen-aws-infra` repository — `stacks/ci-deploy/`, `tools/node/` and
`tools/caddy/`.


## Security

Typed contracts with deny-by-default IAM on every capability, tenant isolation across all four stores, BYOK secrets, and audit lineage on every invocation. To report a vulnerability, see [`SECURITY.md`](SECURITY.md) — please do not open public issues for security reports.

---

## License

**Proprietary.** Copyright © 2024–present Oxagen Inc. All rights reserved. See [`LICENSE`](LICENSE).

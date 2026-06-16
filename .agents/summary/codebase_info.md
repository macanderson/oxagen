# Codebase Info

## Identity

- **Project**: Oxagen Platform
- **Version**: 0.4.0
- **Type**: Pnpm monorepo (Turborepo)
- **License**: Proprietary

## Runtime Requirements

| Requirement | Version |
|---|---|
| Node.js | ≥24 LTS |
| pnpm | ≥10 (enforced via `only-allow`) |
| TypeScript | 6.0.3 |

## Repository Layout

```
oxagen-monorepo/
├── apps/          Customer-facing applications
├── packages/      Shared platform libraries
├── tools/         Internal dev tooling
├── docs/          Specs, ADRs, capability docs, architecture
└── ops/           Ops tooling (Modal sandbox)
```

## Applications (`apps/`)

| App | Package | Port | Purpose |
|---|---|---|---|
| `app` | `@oxagen/app` | 3000 | Next.js 16 web app (App Router, RSC) |
| `api` | `@oxagen/api` | 4000 | Hono HTTP API + Inngest webhook handler |
| `mcp` | `@oxagen/mcp` | 4100 | MCP server (tool protocol) |
| `cli` | `@oxagen/cli` | — | Commander + Ink developer CLI |
| `docs` | `@oxagen/docs` | 3300 | Fumadocs/MDX documentation site |

## Packages (`packages/`)

| Package | Purpose |
|---|---|
| `oxagen` | Capability contracts, kernel, registry — **single source of truth** |
| `handlers` | Handler implementations for all built-in capabilities |
| `agent` | Agent runtime, tool dispatch, memory, approval, subagent fanout |
| `database` | Drizzle ORM + 16 Postgres schemas + Atlas migrations |
| `ai` | Vercel AI SDK helpers, model catalog, streaming, object generation |
| `billing` | Stripe ledger, subscriptions, credits, dunning, pricing |
| `auth` | Better Auth integration, session/token encryption, resolvers |
| `iam` | IAM check, audit emit, access-request creation |
| `inngest-functions` | Durable Inngest job definitions (ingestion, agent, billing) |
| `ingestion` | Universal connector pipeline (GitHub, Linear, Slack, Google, etc.) |
| `plugins` | Plugin registry, credentials, OAuth, entitlement gate |
| `ontology` | Neo4j schema, indexes, execution lineage mutations |
| `telemetry` | ClickHouse client, security event write, migrate |
| `notifications` | Email templates, SMTP transport, org-manager notifications |
| `skills` | Filesystem-first skill loader and registry |
| `sandbox` | Code execution sandbox (Docker, Vercel, Modal) |
| `crypto` | Envelope encryption, KMS adapters |
| `storage` | Vercel Blob adapter, asset ingest |
| `tenancy` | RLS scope propagation (`runInTenantScope`) |
| `compliance` | SOC 2 control DB checks |
| `config` | Zod environment loader, registry |
| `web` | Web fetch + search utilities |
| `ui` | Shared component system (shadcn-style) |

## Technology Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 16, React 19, App Router, Turbopack |
| API | Hono |
| AI | Vercel AI SDK Core |
| Transactional DB | PostgreSQL 16 (Drizzle ORM, Atlas migrations, RLS) |
| Knowledge Graph | Neo4j 5+ |
| Analytics / Events | ClickHouse |
| Background Jobs | Inngest (durable workflows) |
| Auth | Better Auth (passkeys, OAuth, RBAC) |
| Storage | Vercel Blob |
| Testing | Vitest (unit), Playwright (e2e) |
| Build | Turborepo, tsup |
| Language | TypeScript 6 strict mode |

## Key Statistics

- ~265,000 lines of code across ~7,400 files
- 2,148 prioritized source files analyzed
- ~140 capability contracts defined in `packages/oxagen/src/contracts/`
- 16 Postgres schemas (domain-namespaced via `pgSchema`)
- 108 CLI command files

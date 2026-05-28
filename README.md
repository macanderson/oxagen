# Oxagen

Oxagen is an agent platform built around a single capability contract:
every feature is declared once in `packages/oxagen` and exposed
identically through the HTTP API (`apps/api`), the MCP server
(`apps/mcp`), and the interactive app (`apps/app`). Postgres, Neo4j,
and ClickHouse each hold the slice of state they are best at, and
divergence between layers fails the verification gate before it can
ship.

## Quick start

```bash
git clone <repo> oxagen
cd oxagen
cp .env.example .env.local      # fill in the values, all required
pnpm install
pnpm dev                        # boots docker stack + runs migrations + starts every app
```

When you are done, `pnpm kill` stops the apps and tears down the
Docker stack (`pnpm kill -- --volumes` for a full reset).

## Workspace layout

| Path                | Purpose                                                          |
| ------------------- | ---------------------------------------------------------------- |
| `apps/api`          | HTTP API. `/v1` routes import capability declarations.           |
| `apps/app`          | Interactive Next.js app. Vercel AI SDK + RSC streaming.          |
| `apps/mcp`          | MCP server exposing the same capabilities as `apps/api`.         |
| `apps/runner`       | Inngest-backed workflow runner. Sole Neo4j writer.               |
| `apps/website`      | Marketing site. Static.                                          |
| `apps/cli`          | Ink-based developer CLI (`oxagen dev`).                          |
| `packages/oxagen`   | Capability registry — single source of truth.                    |
| `packages/database` | Drizzle schemas and migrations for all 13 Postgres domains.      |
| `packages/config`   | Zod-validated environment loader.                                |
| `packages/auth`     | Better Auth wiring against `auth.users`.                         |
| `packages/ai`       | Vercel AI SDK helpers, model registry.                           |
| `packages/billing`  | Stripe client and credit ledger logic.                           |
| `packages/ontology` | Neo4j schema, node + edge types, vector indexes.                 |
| `packages/telemetry`| ClickHouse client and telemetry helpers.                         |
| `tools/scripts`     | Dev orchestration (`dev`, `kill`, `db:check`, `db:reset`).       |
| `docs/`             | Specs, capability docs, ADRs.                                    |

## Verification gate

```bash
pnpm gate    # lint + typecheck + check:manifest + test + e2e
```

CI runs the same gate on every PR (see `.github/workflows/ci.yml`).

## Spec

The full foundations specification lives at
[`docs/epics/foundations/spec.md`](docs/epics/foundations/spec.md).
Per-capability docs live under [`docs/capabilities`](docs/capabilities).

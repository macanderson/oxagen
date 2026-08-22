# Foundations — Implementation Plan

Owner: TBD. Target: TBD.

This plan tracks execution of `spec.md`. Each phase is independently
mergeable. Acceptance criteria in §2 of the spec gate epic completion.

## Phase 0 — ADRs

Stack decisions are resolved in spec §15. Document each as a one-page
ADR in `docs/adr/` before Phase 1 starts:

- [ ] ADR-001: Drizzle as Postgres ORM
- [ ] ADR-002: Inngest as job orchestration layer
- [ ] ADR-003: Neo4j as vector store (not pgvector)
- [ ] ADR-004: Real Google Secret Manager for local dev (no emulator)
- [ ] ADR-005: Single-version monorepo via Changesets
- [ ] ADR-006: Better Auth bound to canonical `auth.users`

## Phase 1 — Monorepo scaffold

- [ ] Turborepo workspace with `/apps`, `/packages`, `/plugins`, `/tools`
- [ ] App stubs: `api`, `mcp`, `runner`, `app`, `website`
- [ ] Shared `tsconfig`, `eslint`, `prettier` configs in `/packages/config`
- [ ] `pnpm dev` / `pnpm kill` skeletons (no infra wired yet)

Exit: every app builds and runs a "hello world" health endpoint.

## Phase 2 — Datastore infra

- [ ] `docker-compose.dev.yml` for Postgres + Neo4j + ClickHouse
- [ ] Migration tooling per store (Postgres via chosen ORM; ClickHouse
      via versioned `.sql` files; Neo4j via `cypher-shell` migrations)
- [ ] `pnpm db:migrate`, `pnpm db:check`, `pnpm db:reset` commands

Exit: `pnpm dev` brings stack up, runs all migrations, `db:check` is green.

## Phase 3 — Postgres schema

Implement spec §6 in this order (dependencies first):

- [ ] §5 mixins as reusable Drizzle helpers
- [ ] §6.1 organization
- [ ] §6.2 auth
- [ ] §6.3 workspace (with `workspace_users`)
- [ ] §6.4 integration
- [ ] §6.5 agent (with `tool_versions` split)
- [ ] §6.6 workflow
- [ ] §6.7 event (definitions only)
- [ ] §6.8 execution (with `execution_artifacts`,
      `triggered_by_message_id`)
- [ ] §6.9 chat (DAG model with `parent_message_id`,
      `active_leaf_message_id`)
- [ ] §6.10 content (with `files` / `documents` split)
- [ ] §6.11 graph
- [ ] §6.12 evaluation
- [ ] §6.13 billing (full suite)
- [ ] §9 indexes
- [ ] Seed data for local dev (incl. seed `billing.plans`)

Exit: schema matches spec, `db:check` passes, seed loads cleanly.

## Phase 4 — ClickHouse schema

- [ ] §7.1–§7.6 tables with partitioning and TTL
- [ ] Materialized rollups for token usage and event volume
- [ ] Ingestion library in `/packages/telemetry`

Exit: all apps can write telemetry; sample dashboard query returns data.

## Phase 5 — Neo4j ontology and vectors

- [ ] Node and edge type definitions in `/packages/ontology`
- [ ] Constraints and indexes for initial labels
- [ ] Vector indexes (spec §8.1) — `Document`, `AgentMemory`,
      `Chat:Message`
- [ ] Embedding write path from runner; sync state back to Postgres
      `embedding_status` columns
- [ ] Sync command that reconciles Postgres → Neo4j for canonical
      entities (Tenant, Workspace, User, Agent, etc.)

Exit: ontology contains live entities; vector similarity queries
return expected nearest-neighbor results; traversal queries return
expected paths.

## Phase 6 — Env var contract

- [ ] `.env.example` canonical at repo root
- [ ] Zod-validated env loader in `/packages/config`; per-app
      `requiredEnv` exports
- [ ] Pre-commit hook scanning for raw secret values in tracked files
- [ ] GitHub Actions Secrets mirror `.env.example` for CI
- [ ] CI grep verifies no `process.env.X` outside the declared set

Exit: every app fails closed on missing env; `.env.local` is the only
secret-bearing file and it is gitignored.

## Phase 6.5 — `apps/website`

- [ ] Hello-world Next.js page. Nothing else.

Exit: page renders at port 3100.

## Phase 6.6 — `apps/app` shell

Shipped features per spec §2.3. Agent / workflow / execution UIs are
stubbed only.

- [ ] Next.js App Router skeleton with RSC streaming enabled
- [ ] Better Auth wired to `auth.users` via Drizzle adapter; sessions,
      accounts, and verifications migrated under the `auth` schema
- [ ] Google + GitHub OAuth providers configured via Secret Manager
- [ ] Auth: login, logout, session (server components only)
- [ ] Tenant CRUD: create, switch, list; slug routing per §4
- [ ] Workspace CRUD: create, switch, list within tenant
- [ ] Tenant user management: invite, role assignment, revoke
- [ ] Workspace user management: invite, role assignment
- [ ] Vercel AI SDK wired into a placeholder chat surface that
      persists to `chat.conversations` / `chat.messages` per §6.9
- [ ] Stub pages for agents, playbooks, executions (out of scope for
      build-out, but routes exist)

Exit: a new user can sign up, create a tenant, create a workspace,
invite a collaborator, and open a streaming chat against a stub agent.

## Phase 6.7 — Billing (`apps/app` + `apps/api`)

Spec §6.13. The full billing suite is in scope.

- [ ] Stripe customer creation on tenant creation
- [ ] Plan catalogue UI (read from `billing.plans`)
- [ ] Checkout: Stripe Elements payment method capture
- [ ] Subscription create / upgrade / downgrade / cancel / reactivate
- [ ] Payment method management UI
- [ ] Invoice list + hosted invoice / PDF links
- [ ] Current-period usage view (rolled up from ClickHouse
      `token_usage` into `billing.usage_records`)
- [ ] Credit balance + ledger UI
- [ ] Stripe webhook handler in `apps/api` with idempotent processing
      via `billing.stripe_events`
- [ ] Scheduled Inngest job: nightly usage rollup from ClickHouse →
      `billing.usage_records`

Exit: a tenant can subscribe to a plan, pay, see invoices, view usage,
and cancel — end to end against Stripe test mode.

## Phase 7 — Release tooling

- [ ] Changesets configured
- [ ] `pnpm release:patch|minor|major` scripts
- [ ] CI tag-triggered build and publish

Exit: a no-op patch release completes end-to-end against a test
artifact registry.

## Phase 8 — CI

- [ ] PR workflow: typecheck, lint, test, db:migrate, db:check
- [ ] Required status checks configured on `main`

Exit: PR cannot merge without green CI.

## Done

All checkboxes complete and the §2 acceptance criteria pass on a fresh
clone.

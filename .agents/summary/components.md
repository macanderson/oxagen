# Components

## Core Platform Packages

### `packages/oxagen` — Capability Registry & Kernel

The single source of truth for all platform capabilities.

Key files:
- `src/kernel.ts` — `invoke()`, gate injection, `CapabilityError`, `authorizeExternalCapability`
- `src/registry.ts` — `registerCapability`, `getCapability`, `listCapabilities`
- `src/types.ts` — `CapabilityDeclaration`, `CapabilityContext`, `CapabilitySurface`, `ResolvedPrincipal`
- `src/contracts/` — ~140 individual capability contract files
- `src/iam/` — IAM policy resolver (`resolve.ts`) and condition evaluator (`conditions.ts`)
- `src/plugins/` — plugin manifest type + plugin registry
- `capabilities.manifest.json` — generated artifact consumed by `check:manifest`

### `packages/handlers` — Built-in Capability Handlers

Implements every built-in capability (~140 handler files). Each file exports a handler function and is wired into the kernel via `src/register.ts`.

Notable handlers:
- `org.member.role.change.ts`, `org.member.add.ts`, `org.member.remove.ts` — member management
- `chat.message.send.ts` — starts a chat turn, generates title async
- `billing.subscription.read.ts`, `billing.credits.purchase.ts` — billing operations
- `graph.node.upsert.ts`, `graph.cypher.ts`, `ontology.query.ts` — Neo4j graph ops
- `privacy.data.erase.ts`, `privacy.data.export.ts` — GDPR compliance
- `automation.create.ts`, `automation.enable.ts`, `automation.disable.ts` — playbook management
- `plugin.catalog.browse.ts`, `plugin.org.install.ts` — marketplace/plugin management

### `packages/agent` — Agent Runtime

- `src/runtime/materialize-tools.ts` — builds the tool list from capabilities + MCP servers
- `src/runtime/approval.ts` — creates approval requests and waits for resolution
- `src/runtime/knowledge-graph.ts` — injects workspace knowledge context
- `src/runtime/plugin-type.ts` — plugin-contributed tool types
- `src/dispatch/subagent.ts` — subagent fanout dispatch via Inngest
- `src/dispatch/mcp-client.ts` — connects to external MCP servers
- `src/memory/neo4j.ts` — `writeMemory` / `recallMemories`
- `src/handlers/` — agent-surface capability handlers (skill.load, tool.list, plan.create, etc.)
- `src/registry-loader.ts` — `getOxagenRegistry()` for agent tool hydration

### `packages/database` — Postgres Schema & Migrations

- `src/schema/` — 16 Drizzle schema files, one per domain
- `src/relations.ts` — cross-domain Drizzle relations
- `src/tenant.ts` — `withTenantDb`, `withSystemDb`, `assertRlsConnectionSafe`
- `drizzle/` — Atlas-managed SQL migration files
- `atlas.hcl` — Atlas migration configuration

### `packages/ai` — AI Model Abstraction

- `src/models.ts` — model catalog, tier selection (`tierModelId`, `selectModel`)
- `src/catalog.ts` — capability labels, vendor grouping, feature flags
- `src/stream.ts` — `streamAgentReply`, reasoning config
- `src/generate-object.ts` — `generateObjectFor` with retry/fallback
- `src/generate-image.ts`, `src/generate-video.ts` — media generation
- `src/embed.ts` — `embedText` for Neo4j vector store
- `src/prompts/` — system prompt registry, auto-improve, load-config

### `packages/billing` — Stripe Ledger

- `src/stripe-provider.ts` — `StripeProvider` class wrapping all Stripe API calls
- `src/subscriptions.ts` — plan changes, seat management, reactivation
- `src/credits.ts` — credit lots, grants, consumption, effective balance
- `src/metering.ts` — `assertCanStartTurn`, `chargeCostUsd`, `meterCreditsForUsage`
- `src/dunning.ts` — `sweepDunning`, invoice recovery/failure handlers
- `src/pricing.ts` — dynamic markup, margin targets, provider cost derivation
- `src/grants.ts` — credit grant on plan upgrade, invoice paid, free credits
- `src/webhooks.ts` — Stripe webhook dispatch and verification

### `packages/auth` — Authentication

- `src/auth.ts` — Better Auth configuration, `resolveFirstOrgId`
- `src/token-encryption.ts` — envelope encryption/decryption hooks for OAuth tokens
- `src/resolvers/session.ts` — `resolveSession`, `parseSessionCookie`
- `src/resolvers/api-key.ts` — `resolveApiKey`
- `src/resolvers/org.ts`, `src/resolvers/workspace.ts` — scope resolution

### `packages/iam` — Authorization

- `src/fetch-authz.ts` — `fetchAuthz` — loads grants, roles, policies from DB
- `src/check-iam.ts` — `checkIAM`, `isAclCapability`
- `src/emit-audit.ts` — `emitAudit` writes to ClickHouse
- `src/access-request.ts` — `createAccessRequest` for `require_approval` flows

### `packages/ingestion` — Connector Pipeline

- `src/pipeline.ts` — `runPipeline` (normalize → deduplicate → upsert → embed → infer)
- `src/connectors/` — GitHub, Linear, Slack, Google (Gmail/Drive/Calendar/Meet/Contacts/Tasks/BigQuery), Salesforce, Microsoft, Zoom, custom-webhook, custom-sql
- `src/parsers/` — tree-sitter code parsers (TypeScript, Python, JavaScript)
- `src/dedup/resolve.ts` — fuzzy entity deduplication
- `src/infer/` — semantic edge inference
- `src/mutations/upsert-entity.ts` — Neo4j entity + edge upsert

### `packages/plugins` — Plugin System

- `src/registry/` — plugin catalog sync, registry client, README fetching
- `src/credentials/` — workspace secret encryption/decryption, KMS resolution
- `src/oauth/` — OAuth PKCE flow, state store, token persistence
- `src/entitlements/entitlement-service.ts` — `capabilityEntitlementGate`

### `packages/inngest-functions` — Background Jobs

- `src/functions/ingestion.pipeline.ts` — full ingestion run
- `src/functions/playbook.run.execute.ts` — playbook step execution engine
- `src/functions/agent.execute-subagent.ts` — fanout child agent
- `src/functions/billing.rollup-usage.ts` — periodic usage aggregation
- `src/functions/privacy.erasure.execute.ts`, `privacy.export.process.ts` — GDPR
- `src/functions/security.audit-partition-rollover.ts` — ClickHouse partition management

---

## Applications

### `apps/api` — HTTP API

- `src/app.ts` — Hono app setup, all route mounting
- `src/bootstrap.ts` — IAM runtime registration, billing gate injection
- `src/routes/v1/` — route handlers (chat.stream, github-oauth, connection, semantic-edge, etc.)
- `src/middleware/auth.ts`, `error.ts`, `cors.ts`, `org.ts` — middleware chain

### `apps/mcp` — MCP Server

- `src/context.ts` — `buildContext`, `resolveMcpContext`, `McpUnauthorizedError`
- `src/tools/` — one file per capability exposed on the MCP surface
- `src/middleware.ts` — authentication + context hydration

### `apps/app` — Web Application

Key structural areas:
- `src/app/[orgSlug]/[workspaceSlug]/ask/` — main chat interface, server actions
- `src/app/[orgSlug]/[workspaceSlug]/knowledge/` — graph viewer, source management, memory
- `src/app/[orgSlug]/[workspaceSlug]/automation/` — playbooks, triggers, agents
- `src/app/[orgSlug]/billing/` — subscription, usage dashboard, invoices
- `src/app/[orgSlug]/security/` — audit log, MFA, compliance, trust, incidents
- `src/app/[orgSlug]/access/` — IAM roles, policies, principals, sessions, reviews
- `src/app/api/v1/chat/stream/route.ts` — SSE streaming endpoint
- `src/components/chat/` — `ChatShellClient`, `MessageComposer`, `use-tool-stream.ts`, plan card, approval card
- `src/components/knowledge/` — graph components, source wizard, semantic edge viewer
- `src/lib/command-menu/` — intent router, fuzzy match

### `apps/cli` — Developer CLI

- `src/index.tsx` — Commander + Ink root, 108 command files
- `src/commands/` — one file per capability (mirrors MCP tools)
- `src/lib/config.ts` — reads/writes local auth token + org/workspace IDs
- `src/lib/api-client.ts` — `ApiError`, `apiRequest`, `requireAuth`

---

## Tooling (`tools/`)

| Script | Purpose |
|---|---|
| `scripts/dev.ts` | Dev stack launcher: Docker up, migrations, `turbo dev` |
| `scripts/check_manifest.mjs` | API ↔ MCP capability parity check |
| `scripts/check-contracts.mjs` | Validates contract barrel index completeness |
| `scripts/env-check.ts` | Validates `.env.local` against registry |
| `scripts/release.ts` | Full release: version bump, Vercel deploy, NPM publish |
| `scripts/stripe-sync.ts` | Syncs Stripe products/prices from config |
| `scripts/seed-iam-defaults.ts` | Seeds default roles + permission grants |
| `scripts/db-lint-migrations.ts` | Verifies migration integrity |
| `env-manager/` | Local secrets manager with Vercel env sync |

# @oxagen/handlers

`@oxagen/handlers` implements the built-in capability handlers and binds each one to its registered capability name in the kernel. A surface imports `@oxagen/handlers/register` once at boot, and every `invoke()` of a foundation capability then reaches the handler here.

## Boundary

- **Owns:** the handler implementations for the foundation capabilities (organisations, workspaces, members and invites, API keys, billing reads and upgrades, repositories, integrations and plugins, the graph, runs and outcomes, mandates, steering, Tacho, privacy, SSO, and the rest); the lazy registration module `src/register.ts`; and the helpers exported from the barrel for direct callers (`bootstrapOrgIAM`, `provisionMemberPrincipal`, `bootstrapWorkspaceAgents`, `generateApiKey`).
- **Does not own:**
  - Capability contracts, the registry, the kernel, and the gate slots: [`@oxagen/oxagen`](../oxagen/README.md) (`src/contracts/`, `src/kernel.ts`).
  - The `agent.*` handlers (approvals, the MCP registry, agent memory, agent roles, traces): [`@oxagen/agent`](../agent/README.md), registered by `@oxagen/agent/register`.
  - Durable background work a handler dispatches: [`@oxagen/inngest-functions`](../inngest-functions/README.md).
  - The IAM, billing, entitlement, and rules gates: [`@oxagen/iam`](../iam/README.md), [`@oxagen/billing`](../billing/README.md), [`@oxagen/plugins`](../plugins/README.md), and [`@oxagen/rules`](../rules/README.md). Importing this package installs none of them.
  - HTTP, MCP, and CLI wiring: `apps/api`, `apps/mcp`, `apps/cli`.
- **Depends on:** the domain packages whose logic the handlers call.
  - `@oxagen/oxagen`: `registerHandler`, `registerHandlersOnce`, contract types, and `HandlerError`.
  - `@oxagen/database`: `withTenantDb`, `withSystemDb`, the Drizzle schema, and security-event emission.
  - `@oxagen/tenancy`: tenant scope and the data-plane seam.
  - `@oxagen/iam`: `assertOrgRole`, mandate-role checks, and organisation IAM provisioning.
  - `@oxagen/billing`: subscriptions, credits, spend, and metering reads.
  - `@oxagen/plugins`: plugin registry, installs, credentials, and the run-outcomes policy.
  - `@oxagen/agent`: agent identity, definitions, and tool-registry facts.
  - `@oxagen/tacho`: host enrollment, sessions, and the Tacho wire types.
  - `@oxagen/github`: GitHub App tokens and the REST client for repository handlers.
  - `@oxagen/ingestion`: connector registry, filters, and schema validation.
  - `@oxagen/run-ledger` and `@oxagen/run-evidence`: run records, the evidence store, and canonical digests.
  - `@oxagen/ontology`: scoped Neo4j sessions for graph reads.
  - `@oxagen/ai`: metered model calls, the model catalog, and provider posture.
  - `@oxagen/telemetry`: ClickHouse reads and writes and error capture.
  - `@oxagen/rules`: workspace decision rules.
  - `@oxagen/steering-assembler`: the steering assembly for a turn (ADR-093).
  - `@oxagen/config`: env readers and the outbound URL guard.
  - `@oxagen/crypto`: encryption and KMS for stored secrets.
  - `@oxagen/storage`: blob storage for uploaded and generated assets.
  - `@oxagen/notifications`: invite and member email.
  - `@oxagen/auth`: CLI login codes (`./cli-auth`).
  - `@oxagen/inngest-functions`: the event client adapter for dispatching durable work.
- **Used by:** `apps/api`, `apps/app`, `apps/mcp`, `apps/app_deprecated`, and `tools/scripts`.

## Seams

| Seam | Kind | Source | Wired by |
|---|---|---|---|
| `registerHandlersOnce("@oxagen/handlers", ...)` with one lazy `registerHandler(name, loader)` per capability | injection | `packages/handlers/src/register.ts` | Side-effect import in `apps/api/src/bootstrap.ts`, `apps/mcp/src/middleware.ts`, and `apps/app/src/server/kernel.ts` |
| `registerHandler`, `registerHandlersOnce` | registry | `packages/oxagen/src/kernel.ts` | Called by `packages/handlers/src/register.ts` |
| `CapabilityHandlerFn` | port | `packages/oxagen/src/kernel.ts` | Implemented by each handler module in `packages/handlers/src/` |
| `bootstrapOrgIAM`, `provisionMemberPrincipal` | export | `packages/handlers/src/iam-provision.ts` | Organisation creation handlers and `tools/scripts/backfill-org-iam.ts` |
| `generateApiKey` | export | `packages/handlers/src/lib/api-key-authz.ts` | `apps/api/src/routes/v1/auth.cli.token.ts` |

## Entry points

- `.` (`src/index.ts`): selected handlers and bootstrap helpers other packages call directly.
- `./register` (`src/register.ts`): the side-effect module that registers every handler.
- `./*` (`src/*.ts`): any handler module by file name.

## Rules

- The registered capability name is verb-first snake_case and often differs from the file name, which may keep the old dotted stem (ADR-025). `ontology.query.ts` registers `query_ontology`. Read the contract's `name` field, not the file name.
- A new handler needs its contract in `packages/oxagen/src/contracts/`, a barrel entry in `packages/oxagen/src/contracts/index.ts`, and a `registerHandler` line in `src/register.ts`. `pnpm check:manifest` and `pnpm check:contracts` check the parity.
- Registration is lazy. A loader dynamic-imports its handler module on first invoke, so booting a surface does not load Stripe or Drizzle until a capability needs them.
- Keep `src/register.ts` wrapped in `registerHandlersOnce`. A hot reload re-evaluates the module, and a second bare `registerHandler` for the same name throws.
- Registering handlers installs no gate. The surface entry point also calls `bootstrapIAMRuntime`, `bootstrapBillingRuntime`, `bootstrapEntitlementRuntime`, and `bootstrapDecisionRulesRuntime`.
- A scoped handler reads Postgres through `withTenantDb`, or through `withSystemDb` with a `tenancy: system bypass` comment saying why. Raw `db()` is banned by `eslint.tenancy-seams.mjs`.
- A handler that must enforce an organisation role calls `assertOrgRole`. `checkIAM` allows non-enterprise human principals without reading roles.

## Tests

```bash
pnpm --filter @oxagen/handlers test:unit src/api.key.create.test.ts
```

Never put `--` before the filename. Tests live beside each handler in `src/`, with shared fixtures in `src/fixtures/` and `src/test-utils/`.

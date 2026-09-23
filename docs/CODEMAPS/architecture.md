# Source map

Follow these entry points to inspect the current implementation. Counts, package versions, and generated route inventories belong in the source and build output.

## Runtime entry points

| Surface | Entry point | Role |
|---|---|---|
| API | [app.ts](../../apps/api/src/app.ts) | Hono routes, middleware, and webhooks |
| App | [App Router tree](../../apps/app/src/app/) and [architecture](../../apps/app/ARCHITECTURE.md) | the operator console's pages and server actions |
| MCP | [src](../../apps/mcp/src/) | MCP tools and caller context |
| CLI | [index.ts](../../apps/cli/src/index.ts) | Governance operations over the platform API |
| Documentation site | [apps/docs](../../apps/docs/) | Fumadocs content and application |
| Public website | [apps/web](../../apps/web/) | Static website and blog |

## Shared implementation

| Concern | Source |
|---|---|
| Capability definitions and invocation | [Contracts](../../packages/oxagen/src/contracts/), [registry](../../packages/oxagen/src/registry.ts), and [kernel](../../packages/oxagen/src/kernel.ts) |
| Handler loading | [Built-in registration](../../packages/handlers/src/register.ts) and [agent handlers](../../packages/agent/src/handlers/) |
| Tenant scope | [Tenancy](../../packages/tenancy/src/) and [Postgres policy manifest](../../packages/database/src/tenant-policy.manifest.ts) |
| Authentication and authorization | [Auth](../../packages/auth/src/) and [IAM](../../packages/iam/src/) |
| Model calls and billing | [AI](../../packages/ai/src/) and [billing](../../packages/billing/src/) |
| Transactional state | [Drizzle schemas](../../packages/database/src/schema/) and [Atlas migrations](../../packages/database/atlas/migrations/) |
| Graph and telemetry | [Ontology](../../packages/ontology/src/) and [telemetry](../../packages/telemetry/src/) |
| Background work | [Inngest functions](../../packages/inngest-functions/src/functions/) |
| Dependency graph | [Workspace definition](../../pnpm-workspace.yaml), [root manifest](../../package.json), and each package's `package.json` |

## Steering, gating and the gateway

The accepted design separates model-readable steering from deterministic gates. Read [the steering design](../specs/steering/README.md), [gateway spec](../specs/gateway/spec.md), and [Tacho spec](../specs/tacho/README.md) for the design and its implementation boundaries.

Inspect [Tacho](../../packages/tacho/src/), [the steering assembler](../../packages/steering-assembler/src/), and [the kernel](../../packages/oxagen/src/kernel.ts) to establish what a checkout implements. Describe enforcement only for the traffic routed through the relevant gate. A design phase or an old PR status does not prove that enforcement is deployed.

The former generated frontend, backend, data, and dependency maps were removed because they described retired routes, packages, and schemas. This index links their maintained sources.

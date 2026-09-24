# Engineering onboarding

Before changing an agent's identity, mandate, equipment, or record, read [VISION.md](VISION.md) and the relevant capability contract. Oxagen governs actions routed through its control plane. Agent harnesses own their workloads.

## Set up and contribute

Follow the [root README](../README.md) for local setup and [CONTRIBUTING.md](../CONTRIBUTING.md) for branch and PR workflow. [AGENTS.md](../AGENTS.md) and [CLAUDE.md](../CLAUDE.md) hold repository operating rules.

Use CI for builds, lint, typechecks, and suites. The local exception is one test file for code changed by the task. Run it in isolation:

```sh
pnpm --filter @oxagen/<package> test:unit <file>.test.ts
```

Do not put `--` before the filename. It prevents Vitest from using the filename as a test filter.

## Follow the capability path

1. Find the contract in [packages/oxagen/src/contracts](../packages/oxagen/src/contracts/). Read its registered `name`, input, output, scope, and surfaces. Older filenames can differ from the registered verb-first snake_case name.
2. Find its handler registration in [packages/handlers/src/register.ts](../packages/handlers/src/register.ts) or [packages/agent/src/handlers](../packages/agent/src/handlers/).
3. Follow the caller through [the kernel](../packages/oxagen/src/kernel.ts). Surface adapters call `invoke()` so the configured governance and metering gates run.
4. Update the declared surfaces and their [capability documentation](capabilities/_index.md). An app binding is required when the contract declares an app layer.

Use `@oxagen/ai` for model calls and `modelIdOf()` for model resolution. Load the relevant [engineering skill](../.claude/skills/) before changing contracts, tenancy, handlers, or app code.

## Respect storage boundaries

| Store | Purpose | Source |
|---|---|---|
| PostgreSQL | Transactional records, identity, policy, billing, and configuration | [Schema](../packages/database/src/schema/) and [migrations](../packages/database/atlas/migrations/) |
| Neo4j | Entities, relationships, and graph lineage | [Ontology package](../packages/ontology/src/) |
| ClickHouse | Append-only audit and usage events | [Telemetry package](../packages/telemetry/src/) |
| Blob storage | Binary assets | [Storage package](../packages/storage/src/) |

Use `withTenantDb` inside tenant scope for scoped Postgres access. Use `withSystemDb` for authorized system operations. Read [the tenancy package](../packages/tenancy/src/) and [tenant policy manifest](../packages/database/src/tenant-policy.manifest.ts) before changing a scope predicate. The schema and its migrations determine each table's fields and isolation rules.

## Find the design behind the code

- [App architecture](../apps/app/ARCHITECTURE.md) defines the rebuilt app's layers and testing boundaries.
- [Product spec](https://github.com/macanderson/oxagen-roadmap/blob/main/docs/mission-control-spec.md) in the roadmap repository describes product behavior and planned work.
- [ADR index](adr/README.md) records decisions, including the runtime excision and later gateway design.
- [DEREGISTERED.md](../DEREGISTERED.md) identifies features whose code must remain even though their surfaces are unreachable.
- [Source map](CODEMAPS/architecture.md) links the runtime entry points.

Treat older specs and dated audits as design history unless their status says otherwise. Verify a current-behavior claim against the source before copying it into a guide.

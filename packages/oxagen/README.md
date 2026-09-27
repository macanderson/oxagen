# @oxagen/oxagen

The capability kernel. Every surface (API, MCP, the web app, the CLI through
the API) calls one function, `invoke()`, and this package owns that function,
the capability registry it reads, and the contracts that fill the registry.

## Boundary

- **Owns:**
  - `invoke()` and the order its checks run in (`src/kernel.ts`).
  - The capability registry: `registerCapability`, `getCapability`, and
    `listCapabilities` (`src/registry.ts`).
  - Every capability contract, as a Zod input and output schema plus metadata
    (`src/contracts/`).
  - The injection slots for the gates the kernel runs but does not implement:
    IAM, billing, spend budget, plugin entitlement, decision rules, usage
    recording, security events, and trace events.
  - Handler registration (`registerHandler`, `registerHandlersOnce`) and the
    typed errors a caller sees (`CapabilityError`, `HandlerError`).
  - The plugin manifest registry that says which plugin claims a contract
    (`src/plugins/`).
  - The pure IAM policy resolver (`src/iam/`), with no database reads.
- **Does not own:**
  - Handler implementations: [`@oxagen/handlers`](../handlers/README.md) and
    [`@oxagen/agent`](../agent/README.md).
  - The IAM runtime that reads roles and policies from Postgres:
    [`@oxagen/iam`](../iam/README.md).
  - Credit, budget, and usage metering: [`@oxagen/billing`](../billing/README.md).
  - Plugin entitlement queries: [`@oxagen/plugins`](../plugins/README.md).
  - Decision rules and mandates: [`@oxagen/rules`](../rules/README.md).
  - Tenant scope and the data-plane resolver: [`@oxagen/tenancy`](../tenancy/README.md).
  - Running an agent. Oxagen governs agents and does not run them (ADR-043).
- **Depends on:**
  - `@oxagen/tenancy`: `runInTenantScope` and `runWithPrincipal`, which
    `invoke()` enters for scoped capabilities.
  - `@oxagen/config`: the organization vocabularies (type, industry, size) and
    the public URL helpers that some contracts validate against.
  - `@oxagen/tacho`: the wire vocabularies (harness list, transcript kinds,
    replay grades) that Tacho contracts reuse, so the two never drift.
  - `@oxagen/run-evidence`: the proof verdict and disclosure-grain
    vocabularies that run and evidence contracts reuse.
- **Used by:** `apps/api`, `apps/app`, `apps/app_deprecated`, `apps/mcp`,
  `@oxagen/agent`, `@oxagen/ai`, `@oxagen/auth`, `@oxagen/billing`,
  `@oxagen/database`, `@oxagen/handlers`, `@oxagen/iam`,
  `@oxagen/inngest-functions`, `@oxagen/plugins`, `@oxagen/rules`, and
  `tools/scripts`.

## Seams

| Seam | Kind | Source | Wired by |
|---|---|---|---|
| `invoke()` | export | `packages/oxagen/src/kernel.ts` | Called by `apps/api/src/routes/v1/*`, `apps/mcp/src/tools/*`, and `apps/app/src/server/kernel.ts` |
| `registerCapability` / `getCapability` / `listCapabilities` | registry | `packages/oxagen/src/registry.ts` | Each file in `packages/oxagen/src/contracts/`, pulled in by `packages/oxagen/src/contracts.generated.ts` |
| `registerHandler` / `registerHandlersOnce` | registry | `packages/oxagen/src/kernel.ts` | `packages/handlers/src/register.ts`, `packages/agent/src/register.ts` |
| `setKernelIAMRuntime` | injection | `packages/oxagen/src/kernel.ts` | `packages/iam/src/bootstrap.ts` (`bootstrapIAMRuntime`) |
| `setKernelAccessRequestCreator` | injection | `packages/oxagen/src/kernel.ts` | `packages/iam/src/bootstrap.ts` |
| `setBillingAdmissionGate` | injection | `packages/oxagen/src/kernel.ts` | `packages/billing/src/bootstrap.ts` (`bootstrapBillingRuntime`) |
| `setBudgetAdmissionGate` | injection | `packages/oxagen/src/kernel.ts` | `packages/billing/src/bootstrap.ts` |
| `setUsageRecorder` | injection | `packages/oxagen/src/kernel.ts` | `packages/billing/src/bootstrap.ts` |
| `setCapabilityEntitlementGate` | injection | `packages/oxagen/src/kernel.ts` | `packages/plugins/src/entitlements/bootstrap.ts` (`bootstrapEntitlementRuntime`) |
| `setDecisionRulesGate` | injection | `packages/oxagen/src/kernel.ts` | `packages/rules/src/bootstrap.ts` (`bootstrapDecisionRulesRuntime`) |
| `setSecurityEventEmitter` | injection | `packages/oxagen/src/kernel.ts` | `apps/api/src/bootstrap.ts`, `apps/mcp/src/middleware.ts`, `apps/app/instrumentation.ts` |
| `setKernelTraceSink` | injection | `packages/oxagen/src/kernel.ts` | Tests only. No production caller registers a trace sink. |
| `pluginForContract` / `listOxagenPlugins` | registry | `packages/oxagen/src/plugins/registry.ts` | Read by the kernel and `packages/plugins/src/entitlements/entitlement-service.ts`. The built-in manifest list is empty today (ADR-043, ADR-034). |
| `CapabilityDeclaration` and the contract types | port | `packages/oxagen/src/types.ts` | Implemented by every contract file |

Each surface calls the four `bootstrap*Runtime()` functions once at startup:
`apps/api/src/bootstrap.ts`, `apps/mcp/src/middleware.ts`, and
`apps/app/instrumentation.ts`. Importing `@oxagen/handlers/register` registers
handlers and installs no gate.

## Entry points

- `.` (`src/index.ts`): the kernel, registry, handler errors, plugin registry,
  agent schema, trigger conditions, and capability metadata. Importing it
  registers every contract through `src/contracts.generated.ts`.
- `./kernel` (`src/kernel.ts`): `invoke()`, the gate setters, and
  `CapabilityError`, without the contract side effects.
- `./registry` (`src/registry.ts`): the capability registry alone.
- `./contracts` (`src/contracts/index.ts`): the canonical contracts array.
- `./contracts/*` (`src/contracts/<stem>.ts`): one contract. The file stem is
  often the old dotted form. Read the registered `name` inside the file.
- `./types` (`src/types.ts`): `CapabilityDeclaration`, `CapabilityContext`, and
  the surface and layer types.
- `./handler-error` (`src/handler-error.ts`): `HandlerError` and its codes.
- `./iam` (`src/iam/index.ts`): the pure IAM resolver and permission catalog.
- `./plugins` (`src/plugins/index.ts`): the plugin manifest schema and registry.
- `./capability-meta` (`src/capability-meta.ts`): presentation and chaining
  metadata derived from contracts.
- Shared schemas that contracts and handlers both import: `./agent-schema`,
  `./mandates/schemas`, `./mandates/schemas.sample` (test data),
  `./approval-rules/schemas`, `./tacho/schemas`, `./tacho/command-limits`,
  `./skill-frontmatter`, `./skills`, `./configuration-clone`,
  `./agent-version-config`, `./avatar`, and
  `./lib/relationship-type-pattern`.
- Credential and principal helpers: `./platform-operator`, `./agent-credential`,
  `./cli-session`, `./ledger-run-token`, and `./client-ip`.
- Settings vocabularies: `./run-outcomes`, `./run-enrichment`, and
  `./context-record-label`.
- `./interactive-agent` (`src/interactive-agent.ts`): the `qa-chat` agent
  definition shared by the MCP server and the in-app Q&A surface.

## Rules

- `invoke()` runs its checks in one order: input parse, tenant scope, IAM,
  billing, spend budget, plugin entitlement, decision rules, handler, output
  parse, then usage recording.
- The kernel imports none of `@oxagen/iam`, `@oxagen/billing`,
  `@oxagen/plugins`, or `@oxagen/rules`. Each gate arrives through its setter,
  and an unset gate lets the call through.
- A capability's registered `name` is verb-first snake_case with no alias for
  the old dotted form (ADR-025). `pnpm check:naming` enforces it.
- A new contract file goes into `src/contracts/index.ts`. `pnpm check:contracts`
  fails when one is missing.
- `src/contracts.generated.ts` is written by `tools/scripts/check_manifest.mjs`.
  Run `pnpm check:manifest` to regenerate it. Do not edit it by hand.
- A call with no registered handler throws `CapabilityError` with code
  `no_handler`.
- A usage record is written for the top-level governed action only, never for
  a nested `invoke()` (ADR-052).
- `KernelSecurityEvent` carries the capability, outcome, surface, ids, and
  error code. It carries no input and no output.
- The registry and the plugin registry are anchored on `globalThis`, so a
  bundler that evaluates a contract twice still sees one registry.

## Tests

```bash
pnpm --filter @oxagen/oxagen test:unit src/registry.test.ts
```

Tests sit beside their source under `src/`, as `*.test.ts`. The kernel's gate
behavior is split across `src/kernel*.test.ts`.

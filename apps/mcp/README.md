# @oxagen/mcp

The Oxagen MCP server, built on `xmcp`: each file in `src/tools/` exposes one
capability contract as an MCP tool and calls the kernel's `invoke()` with
`surface: "mcp"`.

## Boundary

- **Owns:** the MCP transport (HTTP and stdio), the tool files that map
  contracts to MCP tool metadata, bearer-credential resolution into a
  `CapabilityContext`, and the process bootstrap that installs the kernel
  gates for this surface.
- **Does not own:** contracts, the kernel, or which capabilities declare `mcp`
  ([`@oxagen/oxagen`](../../packages/oxagen/README.md)); handler logic
  ([`@oxagen/handlers`](../../packages/handlers/README.md),
  [`@oxagen/agent`](../../packages/agent/README.md)); API-key resolution
  ([`@oxagen/auth`](../../packages/auth/README.md), `resolveApiKey`); the MCP
  gateway a Tacho host serves to Claude Desktop
  ([`@oxagen/tacho`](../../packages/tacho/README.md),
  `src/collector/mcp-gateway.ts`).
- **Depends on:** `@oxagen/oxagen` (contracts, `invoke`, security-event
  emitter), `@oxagen/handlers` and `@oxagen/agent` (handler registration),
  `@oxagen/auth` (credential resolution), `@oxagen/iam`, `@oxagen/billing`,
  `@oxagen/plugins`, and `@oxagen/rules` (gate bootstraps),
  `@oxagen/database` (RLS boot check, data-plane resolver, security-event
  inserter), `@oxagen/telemetry` (tracing, security events, error capture),
  and `@oxagen/config`.
- **Used by:** no workspace package imports it. MCP clients reach it over HTTP
  or stdio.

## Seams

| Seam | Kind | Source | Wired by |
|---|---|---|---|
| Handler registration (`@oxagen/handlers/register`, `@oxagen/agent/register`) | registry | `apps/mcp/src/middleware.ts` (side-effect imports) | Module load. `xmcp` has no lifecycle hook, so module scope is the bootstrap |
| `bootstrapIAMRuntime()` (installs `setKernelIAMRuntime`) | injection | `apps/mcp/src/middleware.ts` | Module load |
| `bootstrapBillingRuntime()` (installs `setBillingAdmissionGate`) | injection | `apps/mcp/src/middleware.ts` | Module load |
| `bootstrapEntitlementRuntime()` (installs `setCapabilityEntitlementGate`) | injection | `apps/mcp/src/middleware.ts` | Module load |
| `bootstrapDecisionRulesRuntime()` (installs `setDecisionRulesGate`) | injection | `apps/mcp/src/middleware.ts` | Module load |
| `bootstrapDataPlaneResolver()` | injection | `apps/mcp/src/middleware.ts` | Module load, after `assertRlsConnectionSafe()` |
| `setSecurityEventEmitter` | injection | `apps/mcp/src/middleware.ts` | Module load. Also captures `error` outcomes to the error stream |
| `apiKeyAuthMiddleware` (bearer pre-filter) | boundary | `apps/mcp/src/middleware.ts` | `xmcp`, before any tool is dispatched |
| `buildContext(headers())` | adapter | `apps/mcp/src/context.ts` | Every tool in `apps/mcp/src/tools/` |
| Tool directory | registry | `apps/mcp/src/tools/<dotted-stem>.ts` | `xmcp` discovers each file's `schema`, `metadata`, and default export |

The capabilities exposed here are the contracts whose `surfaces` include
`mcp`. `pnpm check:manifest` treats a contract's `mcp` layer as met only when
it declares the surface and a tool file exists.

## Entry points

- `xmcp.config.ts`: transport config (HTTP port `MCP_PORT`, default 4100),
  tool paths, and bundler externals.
- `src/middleware.ts`: the bootstrap and the transport auth gate.
- `src/context.ts`: credential resolution to a `CapabilityContext`.
- `src/tools/`: one file per exposed capability, named by the contract's
  dotted file stem. The tool's `name` is the contract's registered name.
- Built output: `dist/http.js` (`pnpm start`) and `dist/stdio.js`
  (`pnpm start:stdio`).

## Rules

- Identity comes from the validated bearer credential only, never from
  client-supplied `x-oxagen-*` identity headers.
- Only API keys authenticate here. A Better Auth session token is refused
  without a database lookup.
- A CLI session key resolves to the person who approved `oxagen login`. Every
  other key carries `userId: null`. A handler that checks an org role acts as
  the key's creator, through `resolveActingUserId` in
  `packages/iam/src/org-role.ts`.
- Keep heavy packages external in `xmcp.config.ts`. `pnpm check:mcp-externals`
  checks the list.

## Tests

```bash
pnpm --filter @oxagen/mcp test:unit src/context.test.ts
```

Never put `--` before the filename. Tests sit beside their sources:
`src/context.test.ts`, `src/middleware.bootstrap.test.ts`,
`src/tools.auth-gate.test.ts`, and per-tool tests in `src/tools/`.

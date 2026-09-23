# @oxagen/api

The Hono HTTP API: every capability that declares the `api` surface is served
here as a route that calls the kernel's `invoke()`, beside the Stripe, GitHub,
and Inngest webhooks and the Tacho host endpoints.

## Boundary

- **Owns:** HTTP routing, request parsing, bearer-key and session-cookie
  authentication, org and workspace resolution from the URL, rate limits, CORS,
  request logging, and the process bootstrap that installs the kernel gates for
  this surface.
- **Does not own:** capability contracts or kernel behavior
  ([`@oxagen/oxagen`](../../packages/oxagen/README.md)); handler logic
  ([`@oxagen/handlers`](../../packages/handlers/README.md),
  [`@oxagen/agent`](../../packages/agent/README.md)); identity resolution
  ([`@oxagen/auth`](../../packages/auth/README.md): `resolveApiKey`,
  `resolveSession`); the gates themselves ([`@oxagen/iam`](../../packages/iam/README.md),
  [`@oxagen/billing`](../../packages/billing/README.md),
  [`@oxagen/plugins`](../../packages/plugins/README.md),
  [`@oxagen/rules`](../../packages/rules/README.md)); the durable functions it
  serves ([`@oxagen/inngest-functions`](../../packages/inngest-functions/README.md)).
- **Depends on:** `@oxagen/oxagen` (contracts, `invoke`, security-event
  emitter), `@oxagen/handlers` and `@oxagen/agent` (handler registration),
  `@oxagen/auth` (credential resolution), `@oxagen/iam`, `@oxagen/billing`,
  `@oxagen/plugins`, and `@oxagen/rules` (gate bootstraps), `@oxagen/database`
  (RLS boot check, data-plane resolver, security-event inserter),
  `@oxagen/telemetry` (tracing, security events), `@oxagen/config` (env,
  ports), `@oxagen/inngest-functions` (the Inngest serve handler),
  `@oxagen/notifications` (email transport check), and `@oxagen/ai`,
  `@oxagen/crypto`, `@oxagen/github`, `@oxagen/ingestion`,
  `@oxagen/run-ledger`, `@oxagen/storage`, and `@oxagen/tenancy` for
  individual routes. Read `package.json` for the current list.
- **Used by:** no workspace package imports it. It is a deployed service,
  reached over HTTP by `apps/cli`, Tacho hosts, and API clients.

## Seams

| Seam | Kind | Source | Wired by |
|---|---|---|---|
| Handler registration (`@oxagen/handlers/register`, `@oxagen/agent/register`) | registry | `apps/api/src/bootstrap.ts` (side-effect imports) | Module load, before any route runs |
| `bootstrapIAMRuntime()` (installs `setKernelIAMRuntime`) | injection | `apps/api/src/bootstrap.ts` | `bootstrap()`, awaited by `apps/api/src/index.ts` |
| `bootstrapBillingRuntime()` (installs `setBillingAdmissionGate`) | injection | `apps/api/src/bootstrap.ts` | `bootstrap()` |
| `bootstrapDecisionRulesRuntime()` (installs `setDecisionRulesGate`) | injection | `apps/api/src/bootstrap.ts` | `bootstrap()` |
| `bootstrapEntitlementRuntime()` (installs `setCapabilityEntitlementGate`) | injection | `apps/api/src/bootstrap.ts` | `bootstrap()` |
| `bootstrapDataPlaneResolver()` | injection | `apps/api/src/bootstrap.ts` | `bootstrap()`, after `assertRlsConnectionSafe()` |
| `setSecurityEventEmitter` | injection | `apps/api/src/bootstrap.ts` | `bootstrap()`. Writes `capability.invoke_*` events through `makeSecurityEventInserter()` |
| `authMiddleware` (bearer API key or session cookie) | boundary | `apps/api/src/middleware/auth.ts` | `apps/api/src/app.ts` on every authenticated route group |
| `orgMiddleware`, `workspaceMiddleware` | boundary | `apps/api/src/middleware/org.ts`, `workspace.ts` | `apps/api/src/app.ts` on `/v1/:org_slug` and `/v1/:org_slug/:workspace_slug` |
| `capabilityContext(c)` | adapter | `apps/api/src/lib/context.ts` | Every route under `apps/api/src/routes/v1/`, which calls `invoke(name, input, ctx, { surface: "api" })` |
| Inngest serve handler | boundary | `apps/api/src/routes/inngest.ts` | `apps/api/src/app.ts` at `/api/inngest` |

The capabilities served here are the contracts whose `surfaces` include `api`.
`pnpm check:manifest` checks API and MCP parity from each contract's `layers`.
Read
`apps/api/src/app.ts` for the mounted routes rather than a copy here.

## Entry points

- `src/index.ts`: the long-running Node server. It awaits `bootstrap()`, then
  serves `app` on `PORT` (default `PORTS.api` from `@oxagen/config`) and
  `HOST` (default `127.0.0.1`).
- `src/app.ts`: the Hono `app` and its route table.
- `src/bootstrap.ts`: the memoized process bootstrap.
- `build-node.mjs`: bundles `src/index.ts` to CommonJS for deployment.

## Rules

- `bootstrap()` runs `loadEnv()` and `assertRlsConnectionSafe()` before it
  installs any gate, and the server accepts no traffic until it resolves.
- Identity comes from the validated credential only, never from
  client-controlled identity headers.
- `src/index.ts` keeps no top-level `await`, because `build-node.mjs` emits
  CommonJS. `src/__tests__/entrypoint-cjs.test.ts` fails if one returns.
- The server binds loopback by default. The edge proxy publishes it.

## Tests

```bash
pnpm --filter @oxagen/api test:unit src/__tests__/bootstrap.test.ts
```

Never put `--` before the filename. Route and bootstrap tests live in
`src/__tests__/`, and middleware tests sit beside their files in
`src/middleware/`.

# @oxagen/app

The Next.js web app where operators govern their agents: Fleet, Runs,
Mandates, Agents, Tools, Steering, Spend, Skills, and the organization pages.
Every read and write goes through the capability kernel with `surface: "app"`.

[`ARCHITECTURE.md`](./ARCHITECTURE.md) is the reference for this app: its
layers, its seams (§3), its invariants (§4), and its testing policy (§6).
This README names the entry points and the process wiring, and links there
for the rest.

## Boundary

- **Owns:** the pages and routes under `src/app/`, the feature lanes under
  `src/features/`, the data ports and live adapters under `src/data/`, the
  app's own components under `src/ui/`, the viewer and kernel seams under
  `src/server/`, the message catalogues under `messages/`, and the process
  bootstrap in `instrumentation.ts`.
- **Does not own:** contracts and the kernel
  ([`@oxagen/oxagen`](../../packages/oxagen/README.md)); handler logic
  ([`@oxagen/handlers`](../../packages/handlers/README.md),
  [`@oxagen/agent`](../../packages/agent/README.md)); the Better Auth server
  ([`@oxagen/auth`](../../packages/auth/README.md), `@oxagen/auth/route`); the
  gates ([`@oxagen/iam`](../../packages/iam/README.md),
  [`@oxagen/billing`](../../packages/billing/README.md),
  [`@oxagen/plugins`](../../packages/plugins/README.md),
  [`@oxagen/rules`](../../packages/rules/README.md)); shared tokens and brand
  marks ([`@oxagen/ui`](../../packages/ui/README.md)). The former
  `[orgSlug]/[workspaceSlug]` app lives in
  [`apps/app_deprecated`](../app_deprecated/README.md).
- **Depends on:** `@oxagen/oxagen` (contracts, `invoke`), `@oxagen/handlers`
  and `@oxagen/agent` (handler registration), `@oxagen/auth` (sessions),
  `@oxagen/iam`, `@oxagen/billing`, `@oxagen/plugins`, and `@oxagen/rules`
  (gate bootstraps), `@oxagen/database` (RLS boot check, data-plane resolver,
  security-event inserter, pre-scope lookups), `@oxagen/telemetry` (tracing,
  security events, error capture), `@oxagen/compliance`, `@oxagen/storage`,
  and `@oxagen/ui` (styles and brand marks). Read `package.json` for the
  current list.
- **Used by:** no workspace package imports it. It is a deployed Next.js
  service.

## Seams

| Seam | Kind | Source | Wired by |
|---|---|---|---|
| `bootstrapIAMRuntime()` (installs `setKernelIAMRuntime`) | injection | `apps/app/instrumentation.ts` | Next.js `register()`, Node runtime only |
| `bootstrapBillingRuntime()` (installs `setBillingAdmissionGate`) | injection | `apps/app/instrumentation.ts` | `register()` |
| `bootstrapEntitlementRuntime()` (installs `setCapabilityEntitlementGate`) | injection | `apps/app/instrumentation.ts` | `register()` |
| `bootstrapDecisionRulesRuntime()` (installs `setDecisionRulesGate`) | injection | `apps/app/instrumentation.ts` | `register()` |
| `bootstrapDataPlaneResolver()` | injection | `apps/app/instrumentation.ts` | `register()`, after `assertRlsConnectionSafe()` |
| `setSecurityEventEmitter` | injection | `apps/app/instrumentation.ts` | `register()` |
| `onRequestError` | injection | `apps/app/instrumentation.ts` | Next.js, for every uncaught server error. Sends it to `captureError` |
| Handler registration (`@oxagen/handlers/register`, `@oxagen/agent/register`) | registry | `apps/app/src/server/kernel.ts` (`loadRegistries`) | Loaded once, lazily, before the first `invoke()` |
| `kernelRead` / `kernelWrite` | boundary | `apps/app/src/server/kernel.ts` | Pages and server actions. The only path to `invoke()` (ARCHITECTURE.md §3.2) |
| `requireViewer` / `resolveViewer` | boundary | `apps/app/src/server/viewer.ts` | Every page, layout, and route under an `[org]` segment (INV-01, ARCHITECTURE.md §3.1) |
| Session cookie gate and legacy redirects | boundary | `apps/app/src/proxy.ts` | Next.js `proxy` on every request |
| Better Auth handler | adapter | `apps/app/src/app/api/auth/[...all]/route.ts` | `handleAuthRequest` in `src/server/session.ts`, which loads `@oxagen/auth/route` |
| Data ports | port | `apps/app/src/data/ports.ts` | Live adapters in `src/data/live/` (ARCHITECTURE.md §3.3) |
| Capability to UI binding | boundary | `apps/app/capability-ui-map.json` | `pnpm check:ui-parity` |
| Tenancy and navigation import bans | boundary | `apps/app/eslint.config.mjs` | ESLint. It imports `eslint.tenancy-seams.mjs` from the repo root |

A contract that declares the `app` layer must have a binding in
`capability-ui-map.json`, and `pnpm check:ui-parity` enforces it. Read
`src/app/` and `e2e/routes.ts` for the current routes.

## Entry points

- `instrumentation.ts`: the Next.js startup hook. It must stay at the app
  root, next to `next.config.ts`.
- `src/app/`: App Router pages, layouts, and route handlers.
- `src/proxy.ts`: request interception (Next 16 `proxy`).
- `next.config.ts`: build config, including `transpilePackages`.
- `messages/`: translation catalogues. `src/i18n/messages.d.ts` is generated
  from them by `pnpm --filter @oxagen/app gen:messages`.

## Rules

- A page reads through `kernelRead` and a server action writes through
  `kernelWrite`. Nothing else calls `invoke()` (ARCHITECTURE.md §3.2).
- Every page, layout, and route under an `[org]` segment resolves its own
  viewer (INV-01). A layout check is not a tenancy boundary.
- UI imports come from `@/ui/<name>`, and shell chrome uses the component
  tokens listed in the root `AGENTS.md`.
- `e2e/` holds exactly `login`, `pay`, and `page-load`. Every other flow is a
  component or action test (ARCHITECTURE.md §6.3).
- Regenerate and commit `src/i18n/messages.d.ts` after a catalogue change.
  `check:messages` fails when it is stale.

## Tests

```bash
pnpm --filter @oxagen/app test:unit src/server/kernel.test.ts
```

Never put `--` before the filename. Unit and component tests sit beside
their sources. Architecture probes live in `src/test/arch/`, and the three
Playwright specs live in `e2e/` and run in CI.

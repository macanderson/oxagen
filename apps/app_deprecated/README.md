# @oxagen/app-deprecated

> **Deprecated.** This is the web app from before the `apps/app` rebuild, moved here from
> `apps/app` on the `app-rebuild` integration branch. It is no longer deployed (no `vercel.json`,
> no `test:e2e`) and `tools/scripts/dev.ts` excludes it from `pnpm dev`. The UI-parity,
> mobile-parity and manifest gates now read `apps/app` (`APP_DIR` in
> `tools/scripts/lib/app-dir.mjs`), not this directory. Check `DEREGISTERED.md` before you delete
> any of its files.

The former Oxagen web app: **Next.js 16** (App Router, RSC, Turbopack),
streaming AI surfaces via the Vercel AI SDK, and the **coss ui** component
system from [`@oxagen/ui`](../../packages/ui/README.md).

## Boundary

- **Owns:** the former `[orgSlug]/[workspaceSlug]` routes, the chat
  generative-UI layer and its component registry (`src/components/chat/`),
  its chat stream route (`src/app/api/v1/chat/stream/`), and this
  app's Storybook.
- **Does not own:** the current web app ([`apps/app`](../app/README.md)),
  which replaced it; contracts and handlers
  ([`@oxagen/oxagen`](../../packages/oxagen/README.md),
  [`@oxagen/handlers`](../../packages/handlers/README.md)); shared
  primitives ([`@oxagen/ui`](../../packages/ui/README.md)). Do not copy its
  `use-tool-stream.ts` path into new app guidance.
- **Depends on:** the platform packages it calls in-process, including
  `@oxagen/oxagen`, `@oxagen/handlers`, `@oxagen/agent`, `@oxagen/ai`,
  `@oxagen/auth`, `@oxagen/database`, `@oxagen/iam`, `@oxagen/billing`,
  `@oxagen/plugins`, `@oxagen/rules`, `@oxagen/telemetry`, `@oxagen/tenancy`,
  and `@oxagen/ui`. Read `package.json` for the current list.
- **Used by:** no workspace package or deployment.

## Seams

| Seam | Kind | Source | Wired by |
|---|---|---|---|
| `bootstrapIAMRuntime()`, `bootstrapBillingRuntime()`, `bootstrapEntitlementRuntime()`, `bootstrapDecisionRulesRuntime()` | injection | `apps/app_deprecated/instrumentation.ts` | Next.js `register()`, Node runtime only |
| `bootstrapDataPlaneResolver()`, `setSecurityEventEmitter` | injection | `apps/app_deprecated/instrumentation.ts` | `register()`, after `assertRlsConnectionSafe()` |
| Handler registration (`@oxagen/handlers/register`) | registry | Side-effect imports in the modules that invoke, for example `src/components/chat/budget-actions.ts` | Module load |
| Request interception | boundary | `apps/app_deprecated/src/proxy.ts` | Next.js `proxy` |
| `@oxagen/ui` re-export layer | adapter | `apps/app_deprecated/src/components/ui/` | `eslint.next.mjs` refuses direct `@oxagen/ui/components/*` imports elsewhere |

## Entry points

- `instrumentation.ts`: the startup hook that installs the gates.
- `src/app/`: App Router routes.
- `src/proxy.ts`: request interception (not `middleware.ts`).

## Tests

```bash
pnpm --filter @oxagen/app-deprecated test:unit src/proxy.test.ts
```

Never put `--` before the filename. Tests sit beside their sources.

## Notes

- Dev server: `http://localhost:3000`
- Request interception: `src/proxy.ts` (not `middleware.ts`)
- Chat transport: `POST /api/v1/chat/stream` (SSE) → `use-tool-stream.ts`

UI components are imported from the local re-export proxy
(`@/components/ui/<name>`), **never** from `@oxagen/ui/components/*` directly
(enforced by `no-restricted-imports`). See [`@oxagen/ui`](../../packages/ui)
for the full primitive inventory.

## Storybook

This app's Storybook covers UI that only lives in `apps/app_deprecated`, most of it the
**chat generative-UI layer**, the registry components a model can render as
structured output in a conversation. (Shared primitives like Button, Dialog,
and Select are documented in the
[`@oxagen/ui` Storybook](../../packages/ui/README.md#storybook).)

```bash
# from the repo root
pnpm --filter @oxagen/app-deprecated storybook        # dev server → http://localhost:6007
pnpm --filter @oxagen/app-deprecated build-storybook  # static build → storybook-static/

# or from apps/app_deprecated
pnpm storybook
```

Config lives in `.storybook/`. Four directories are picked up — add a story
outside them and Storybook will not see it:

| Glob | What it covers |
|------|----------------|
| `src/components/chat/**` | chat cards, panels, and the generative-UI registry |
| `src/components/knowledge/**` | the schema builder |
| `src/components/sandbox/**` | the sandbox terminal |
| `src/app/**/workbench/**` | workbench surfaces (e.g. the agents grid) |

Each story sets its own `title`, which is what groups it in the sidebar —
chat stories use the `Chat/*` prefix. Do not maintain a story list here; it
goes stale. Run Storybook, or `rg "title:" -g "*.stories.tsx" src` for the
current inventory.

## Common commands

```bash
pnpm --filter @oxagen/app-deprecated dev          # Next on :3000 plus Storybook; `pnpm dev` skips this app
pnpm --filter @oxagen/app-deprecated typecheck
pnpm --filter @oxagen/app-deprecated lint
pnpm --filter @oxagen/app-deprecated test:unit src/proxy.test.ts   # one file; CI runs the suite
pnpm --filter @oxagen/app-deprecated storybook    # Storybook dev (:6007)
pnpm --filter @oxagen/app-deprecated build-storybook
```

## Stack notes

- **AI:** Vercel AI SDK Core (`streamText`/`generateText`/`streamObject`/
  `generateObject`) on the server, via `@oxagen/ai`. **Never `ai/rsc`.**
- **Generative UI:** the model returns `generateObject` structured output;
  the client maps it to React via the chat component registry — no
  server-rendered React trees.
- **Theming:** `@oxagen/ui` `ThemeProvider` (cookie-based, no-flash); `.dark`
  on `<html>` flips the token set.

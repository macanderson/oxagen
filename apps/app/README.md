# @oxagen/app

The primary Oxagen web app — **Next.js 16** (App Router, RSC, Turbopack),
streaming AI surfaces via the Vercel AI SDK, and the **coss ui** component
system from [`@oxagen/ui`](../../packages/ui).

- Dev server: `http://localhost:3000`
- Request interception: `src/proxy.ts` (not `middleware.ts`)
- Chat transport: `POST /api/v1/chat/stream` (SSE) → `use-tool-stream.ts`

UI components are imported from the local re-export proxy
(`@/components/ui/<name>`), **never** from `@oxagen/ui/components/*` directly
(enforced by `no-restricted-imports`). See [`@oxagen/ui`](../../packages/ui)
for the full primitive inventory.

## Storybook

This app's Storybook covers UI that only lives in `apps/app` — most of it the
**chat generative-UI layer**, the registry components a model can render as
structured output in a conversation. (Shared primitives like Button, Dialog,
and Select are documented in the
[`@oxagen/ui` Storybook](../../packages/ui/README.md#storybook).)

```bash
# from the repo root
pnpm --filter @oxagen/app storybook        # dev server → http://localhost:6007
pnpm --filter @oxagen/app build-storybook  # static build → storybook-static/

# or from apps/app
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
pnpm dev                # start all apps + Docker (from repo root)
pnpm --filter @oxagen/app typecheck
pnpm --filter @oxagen/app lint
pnpm --filter @oxagen/app test:unit
pnpm --filter @oxagen/app storybook         # Storybook dev (:6007)
pnpm --filter @oxagen/app build-storybook
```

## Stack notes

- **AI:** Vercel AI SDK Core (`streamText`/`generateText`/`streamObject`/
  `generateObject`) on the server, via `@oxagen/ai`. **Never `ai/rsc`.**
- **Generative UI:** the model returns `generateObject` structured output;
  the client maps it to React via the chat component registry — no
  server-rendered React trees.
- **Theming:** `@oxagen/ui` `ThemeProvider` (cookie-based, no-flash); `.dark`
  on `<html>` flips the token set.

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

This app's Storybook covers the **chat generative-UI layer** — the registry
components a model can render as structured output in a conversation. (Shared
primitives like Button/Dialog/Select are documented in the
[`@oxagen/ui` Storybook](../../packages/ui/README.md#storybook).)

```bash
# from the repo root
pnpm --filter @oxagen/app storybook        # dev server → http://localhost:6007
pnpm --filter @oxagen/app build-storybook  # static build → storybook-static/

# or from apps/app
pnpm storybook
```

Config lives in `.storybook/`; stories are
`src/components/chat/**/*.stories.tsx`.

### Chat component inventory (`Chat/*`)

| Story | Component | Renders |
|-------|-----------|---------|
| `Chat/CapabilityChainCard` | `capability-chain-card` | a chained capability run |
| `Chat/CapabilityResult` | `capability-result` | a single capability result |
| `Chat/ConversationListCard` | `conversation-list-card` | a list of conversations |
| `Chat/GraphEdgeCard` | `graph-edge-card` | a knowledge-graph edge |
| `Chat/GraphIngestCard` | `graph-ingest-card` | a graph ingestion summary |
| `Chat/GraphNodeCard` | `graph-node-card` | a single graph node |
| `Chat/GraphNodeListCard` | `graph-node-list-card` | a list of graph nodes |
| `Chat/ResearchSwarmCard` | `research-swarm-card` | a research swarm run |
| `Chat/WebSearchCard` | `web-search-card` | web-search results |

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

# Chat capability component screenshots

Rendered from Storybook (`apps/app/.storybook`) — the generative-UI layer that
maps a capability's output to a typed, deep-linked React component so the user
never sees raw JSON. Regenerate by running `pnpm --filter @oxagen/app storybook`
and capturing each story's `iframe.html?id=…` view.

| Component | Renders | Screenshot |
| --- | --- | --- |
| `research-swarm-card` | `research.swarm.start` / `.status` — live progress + the actual web-search hits per query (links) | ![](research-swarm-card.png) |
| `graph-ingest-card` | `graph.ingest` — extracted entities + relationships with confidence labels, deep-linked nodes | ![](graph-ingest-card.png) |
| `capability-chain-card` | `agent.compose` — the composed chain with per-step status + expandable input/output | ![](capability-chain-card.png) |
| `web-search-card` | `web.search` — ranked results with title, domain, snippet | ![](web-search-card.png) |
| `graph-node-list-card` | `graph.node.list` / `.search` — nodes deep-linked to detail pages | ![](graph-node-list-card.png) |
| `graph-node-card` | `graph.node.get` / `.upsert` — a single node with properties + open link | ![](graph-node-card.png) |
| `graph-edge-card` | `graph.edge.upsert` — relationship with deep-linked endpoints | ![](graph-edge-card.png) |
| `conversation-list-card` | `conversation.list` — conversations deep-linked to their chat pages | ![](conversation-list-card.png) |
| `capability-result` | generic fallback — any capability's output as typed key/value + record links | ![](capability-result.png) |

---
# Graph

- **Route:** `/{orgSlug}/{workspaceSlug}/knowledge/graph`
- **Nav location:** workspace → Knowledge → tab "Graph"
- **Priority:** P1
- **Disposition vs today:** Rename + Merge

## Purpose
The single place to see, search, and traverse the workspace's governed context graph — the visible face of the accuracy moat. Today `knowledge/explore` is a WebGL-only canvas (reagraph) with no way to browse or search nodes by label/property; there is no node-list UI anywhere in the app. This page merges the existing explorer with a paginated node browser, fuzzy/semantic search, and typed traversal controls, so the graph is operable rather than merely visualized.

The exact live code graph stays local to each checkout/worktree. This shared view contains governed source facts and stable provider metadata, not repository source text, symbols, chunks, code embeddings, or uncommitted state. Canonical protected/default-ref topology and typed run evidence are follow-ups.

## Primary user & jobs-to-be-done
- **Primary user:** anyone verifying, curating, or debugging what an agent knows
- **JTBD:**
  - Visually explore the graph's structure and neighborhoods
  - Find a specific node by name, label, or fuzzy/semantic match
  - Run a typed, allow-listed traversal without submitting raw Cypher
  - Jump from a chat citation straight into the node's place in the graph
  - Inspect a bounded, scoped subgraph without creating a client-side graph dump

## Functionality
- **Canvas (primary):** reagraph WebGL explorer — pan/zoom, layout selection, node/edge click-through.
- **Side panel — Browse:** paginated node list with label filter chips, sortable by recency/degree.
- **Side panel — Search:** fuzzy text box plus a "semantic" toggle for NL-embedding search.
- **Traversal tab:** choose a start node, allow-listed relationship types, direction, and depth; results render as a table with clickable node refs.
- **Deep-link:** `?focus=<publicId>` opens the canvas centered on a specific node — the target for chat "Grounded in" citations and Cmd+K.
- Node clicks in canvas, browse list, or query results open the node detail route.
- Apply the citation rule throughout: every materialized node/edge reference uses `NodeRef`/label chips, never a raw UUID.

## Capabilities invoked
- `graph.node.list` (`list_nodes`) — paginated browse.
- `graph.node.search` (`search_nodes`) — fuzzy search.
- `graph.search` (`search_graph`) — NL semantic search.
- `graph.stats` (`get_graph_stats`) — summary counts shown in the panel header.
- `ontology.neighbors` (`get_ontology_neighbors`) — expand a node's neighborhood on canvas.
- `ontology.query` (`query_ontology`) — typed, ontology-aware traversal.

## Data sources
Neo4j exclusively — governed nodes, relationships, ontology labels, and embeddings for eligible shared knowledge. Existing explorer streams from `/api/v1/graph/explore`; new panels call the contracts above via `invoke()`, not that route directly.

## States
- **Empty:** no nodes ingested yet — canvas shows "Connect a source" pointing at Sources.
- **Loading:** canvas shows a spinner overlay; browse/search panels show skeleton rows independently.
- **Error:** traversal validation errors render inline; canvas/browse fail open to empty rather than blocking the page.

## Existing implementation
- **Today:** `apps/app/src/app/[orgSlug]/[workspaceSlug]/knowledge/explore/page.tsx` is COMPLETE for canvas-only exploration (`GraphExplorer` component, `focusNodeId` deep-link already wired). Rename route `explore` → `graph`, keep the canvas component, and build the browse/search/typed-traversal panels as new additions alongside it.

## Vision alignment
Graph grounding is the accuracy moat; today it's provable only by staring at a force-directed layout. Adding browse/search/traversal makes the moat operable and demonstrable — P1 because it's the missing verification surface for every cited answer.

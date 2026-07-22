---
# Graph

- **Route:** `/{orgSlug}/{workspaceSlug}/knowledge/graph`
- **Nav location:** workspace → Knowledge → tab "Graph"
- **Priority:** P1
- **Disposition vs today:** Rename + Merge

## Purpose
The single place to see, search, and query the workspace's knowledge graph — the visible face of the accuracy moat. Today `knowledge/explore` is a WebGL-only canvas (reagraph) with no way to browse or search nodes by label/property; there is no node-list UI anywhere in the app. This page merges the existing explorer with a paginated node browser, fuzzy/semantic search, and a query console, so the graph is both explorable and queryable, not just visualized.

## Primary user & jobs-to-be-done
- **Primary user:** anyone verifying, curating, or debugging what an agent knows
- **JTBD:**
  - Visually explore the graph's structure and neighborhoods
  - Find a specific node by name, label, or fuzzy/semantic match
  - Run an ad-hoc Cypher (or natural-language) query against the graph
  - Jump from a chat citation straight into the node's place in the graph
  - Export a subgraph for offline inspection

## Functionality
- **Canvas (primary):** reagraph WebGL explorer — pan/zoom, layout selection, node/edge click-through.
- **Side panel — Browse:** paginated node list with label filter chips, sortable by recency/degree.
- **Side panel — Search:** fuzzy text box plus a "semantic" toggle for NL-embedding search.
- **Query console tab:** Cypher input with syntax highlighting, or natural-language input toggled to NL→Cypher translation; results render as a table with clickable node refs.
- **Deep-link:** `?focus=<publicId>` opens the canvas centered on a specific node — the target for chat "Grounded in" citations and Cmd+K.
- **Export:** subgraph export (current selection or query result) to file.
- Node clicks in canvas, browse list, or query results open the node detail route.
- Apply the citation rule throughout: every node/edge reference uses `NodeRef`/label chips, never a raw UUID; unmaterialised targets render as described candidates with `id: null`.

## Capabilities invoked
- `graph.node.list` (`list_nodes`) — paginated browse.
- `graph.node.search` (`search_nodes`) — fuzzy search.
- `graph.search` (`search_graph`) — NL semantic search.
- `graph.stats` (`get_graph_stats`) — summary counts shown in the panel header.
- `graph.cypher` (`run_cypher`, `nlQuery=true` for NL mode) — query console.
- `graph.export` (`export_graph`) — subgraph export.
- `ontology.neighbors` (`get_ontology_neighbors`) — expand a node's neighborhood on canvas.
- `ontology.query` (`query_ontology`) — ontology-aware traversal from the console.

## Data sources
Neo4j exclusively — nodes, relationships, ontology labels, embeddings for semantic search. Existing explorer streams from `/api/v1/graph/explore`; new panels call the contracts above via `invoke()`, not that route directly.

## States
- **Empty:** no nodes ingested yet — canvas shows "Connect a source" pointing at Sources.
- **Loading:** canvas shows a spinner overlay; browse/search panels show skeleton rows independently.
- **Error:** query console shows the raw Cypher/validation error inline; canvas/browse fail open to empty rather than blocking the page.

## Existing implementation
- **Today:** `apps/app/src/app/[orgSlug]/[workspaceSlug]/knowledge/explore/page.tsx` is COMPLETE for canvas-only exploration (`GraphExplorer` component, `focusNodeId` deep-link already wired). Rename route `explore` → `graph`, keep the canvas component, and build the browse/search/query-console panels as new additions alongside it.

## Vision alignment
Graph grounding is the accuracy moat; today it's provable only by staring at a force-directed layout. Adding browse/search/query makes the moat operable and demonstrable — P1 because it's the missing verification surface for every cited answer.

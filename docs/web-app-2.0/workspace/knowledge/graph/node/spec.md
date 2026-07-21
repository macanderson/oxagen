---
# Node detail

- **Route:** `/{orgSlug}/{workspaceSlug}/knowledge/graph/[nodeId]`
- **Nav location:** reached from Graph canvas/browse, chat citations, and Cmd+K
- **Priority:** P2
- **Disposition vs today:** Move

## Purpose
The inspectable ground-truth view of a single graph node — its full property bag, provenance, and neighborhood — that every citation, chat answer, and graph interaction should resolve to. It exists today but is reachable only via Cmd+K, since the old `knowledge/nodes` index just redirects into Inference; this move gives it a stable home under Graph, where users actually land after browsing or searching.

## Primary user & jobs-to-be-done
- **Primary user:** anyone verifying what a cited fact is grounded in
- **JTBD:**
  - Confirm a chat citation's underlying node data, not just its label
  - See a node's neighbors to understand its place in the graph
  - Copy the raw id when it's genuinely needed (support, debugging)
  - Route a correction back through the governed source that produced the record

## Functionality
- Header: human `displayName` + domain `label` badge (never the UUID as primary identifier); description if present.
- Properties section: full property bag, linkified where a value is a URL.
- Metadata/provenance section: created/updated timestamps, source connection if known, copyable raw id (`CopyableId`) — the only place the UUID appears.
- Neighbors section (new): adjacent nodes rendered as `NodeRef` chips grouped by relationship type, each opening its own node detail on click.
- Not-found state: friendly message with a back link, distinguishing "doesn't exist" from "no access."
- Provenance actions link to the owning source; the detail page does not expose generic graph mutation.

## Capabilities invoked
- `graph.node.get` (`get_node`) — primary fetch.
- `graph.node_label.get` (`get_node_labels`) — label badges.
- `ontology.neighbors` (`get_ontology_neighbors`) — neighbors section.

## Data sources
Neo4j exclusively — node, labels, properties, relationships.

## States
- **Empty:** properties section shows "No properties recorded" if the bag is empty; neighbors section shows "No connected nodes."
- **Loading:** header + properties render together once `get_node` resolves (single fetch, no partial skeleton today); neighbors section can stream independently behind its own Suspense once added.
- **Error:** node fetch failure or missing node renders the existing friendly not-found card, never a raw 500.

## Existing implementation
- **Today:** `apps/app/src/app/[orgSlug]/[workspaceSlug]/knowledge/nodes/[nodeId]/page.tsx` is COMPLETE for properties/provenance/metadata and the not-found state. Move the route under `knowledge/graph/[nodeId]`; add the neighbors section and provenance links; make `NodeRef` chips app-wide link here instead of only opening the hover popover, so this page becomes reachable by click, not just Cmd+K.

## Vision alignment
This is the citation rule made real: a node is never just an id, it's an inspectable, labeled, sourced record — P2 because the data is already correct today, the gap is discoverability, not correctness.

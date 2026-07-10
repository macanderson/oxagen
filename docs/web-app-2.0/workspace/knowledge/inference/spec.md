---
# Inference

- **Route:** `/{orgSlug}/{workspaceSlug}/knowledge/inference`
- **Nav location:** workspace → Knowledge → tab "Inference"
- **Priority:** P1
- **Disposition vs today:** Keep

## Purpose
The human-in-the-loop review queue for LLM-inferred graph edges and relationships — where speculative connections the model proposed get confirmed or rejected before they become citable fact. This is the governance half of graph grounding: nothing joins the graph as an asserted relationship without either a source connector or an explicit human approval recorded here.

## Primary user & jobs-to-be-done
- **Primary user:** a data owner or admin curating graph quality
- **JTBD:**
  - See graph health at a glance (node/edge counts, growth)
  - Review each pending inferred edge with its confidence, source, and endpoints
  - Approve or reject individually, or bulk-act on a filtered set
  - Trigger a fresh inference pass on demand
  - Browse already-approved edges to audit what's been confirmed

## Functionality
- **Stats section:** node/edge counts and recent growth (`graph.stats`), streamed independently.
- **Pending review section:** queue of LLM-suggested edges — confidence meter, source (connector or inference run), source/target endpoints rendered as `NodeRef` chips (resolved server-side to `knowledgeNodeRef`, never a raw id). Approve/Reject per row; bulk select + bulk approve/reject.
- **"Run inference" trigger:** kicks off a fresh `semantic.edge.infer` / `semantic.relationship.infer` pass over unreviewed graph content; shows a running/queued state.
- **Approved-edge browser section:** paginated, filterable by relationship type, source, and confidence threshold; read-only, links each endpoint to node detail.
- Each of the three sections is an independent Suspense boundary and fails open (renders empty, never blocks the others).

## Capabilities invoked
- `graph.stats` (`get_graph_stats`) — stats section.
- `semantic.edge.suggest` (`suggest_semantic_edges`) — pending queue (edge family).
- `semantic.edge.list` (`list_semantic_edges`) — approved browser (edge family).
- `semantic.edge.approve` (`approve_semantic_edge`) — approve/reject action.
- `semantic.edge.infer` (`infer_semantic_edges`) — run-inference trigger.
- `semantic.relationship.suggest` / `.list` / `.approve` / `.infer` — the parallel relationship-family capabilities, same UI treatment.

## Data sources
Neo4j (edges/relationships, both pending and approved) plus an async inference job queue that populates the pending set.

## States
- **Empty:** pending queue shows "No candidates awaiting review"; approved browser shows "No approved edges yet."
- **Loading:** each of the 3 sections shows its own skeleton (`StatCardsSkeleton`, `TableSkeleton` x2) independently.
- **Error:** any section's fetch failure renders that section's empty state and logs server-side; the other two sections are unaffected.

## Existing implementation
- **Today:** `apps/app/src/app/[orgSlug]/[workspaceSlug]/knowledge/inference/page.tsx` is COMPLETE — 3 Suspense sections (`GraphStatsSection`, `PendingInferencesSection`, `ApprovedEdgesSection`), fail-open per section. Reverse-parity note: `semantic.edge.*` / `semantic.relationship.*` contracts are invoked here but omit `app` from `layers[]` — declare it to close the `check:ui-parity` false gap.

## Vision alignment
Human-approved, cited, time-aware edges are exactly what makes the graph trustworthy rather than merely large — grounding accuracy plus the governance/accountability chain in one page; P1 because unreviewed inference is the fastest way to poison the moat.

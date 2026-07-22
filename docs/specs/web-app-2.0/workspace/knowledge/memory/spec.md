---
# Memory

- **Route:** `/{orgSlug}/{workspaceSlug}/knowledge/memory`
- **Nav location:** workspace → Knowledge → tab "Memory"
- **Priority:** P1
- **Disposition vs today:** Rename

## Purpose
The browser for AgentMemory — durable, cited facts and preferences agents accumulate across conversations, distinct from the ingested source graph. Renaming from `knowledge/memories` to `knowledge/memory` aligns it with the singular tab naming used elsewhere in Knowledge (Sources, Graph, Inference, Ontology) and reads as "the memory layer," not "a list of memory rows."

## Primary user & jobs-to-be-done
- **Primary user:** an admin or agent builder auditing or curating what agents remember
- **JTBD:**
  - Browse, search, and filter stored memories by type/agent/recency
  - Edit or delete a memory found to be wrong or stale
  - Promote a candidate memory to a durable, org-wide fact
  - See what a memory influenced (citations) and any rule violations tied to it
  - Bulk-import memories from an external source

## Functionality
- **Memory list:** paginated, filterable by type (fact/preference/episodic), agent, recency; CRUD row actions (edit, delete).
- **Save/promote:** create a new memory manually; promote a candidate memory to durable/org-scoped status — FACT-type promotions require explicit human confirmation before taking effect.
- **Bulk import:** parse-then-commit two-step flow for importing memory sets from a file/external source, with a preview/diff before commit.
- **Citations view (new):** for a selected memory, show what answers or decisions it influenced, and any recorded rule violations.
- **Evidence attach (new):** attach supporting evidence (a graph node, a conversation turn) to a memory to strengthen its provenance.
- **Promotion candidates queue (new):** memories flagged as promotion-worthy, awaiting the human confirmation step above.
- Cross-link (don't duplicate): the memory *decay policy* editor lives in Workspace Settings → Agent Defaults — link out to it rather than re-implementing.

## Capabilities invoked
- `agent.memory.list` (`list_memories`), `agent.memory.remember` (`save_memory`), `agent.memory.update` (`update_memory`), `agent.memory.delete` (`delete_memory`), `agent.memory.promote` (`promote_memory`), `agent.memory.recall` (`recall_memory`), `agent.memory.write` (`write_memory`).
- `agent.memory_import.parse` / `.commit` (`parse_memory_import` / `commit_memory_import`) — bulk import.
- `agent.memory_citation.list` (`list_memory_citations`) — citations view.
- `agent.memory_evidence.attach` (`attach_memory_evidence`) — evidence attach.
- `agent.memory_promotion.list` (`list_memory_promotions`) — promotion candidates queue.

## Data sources
Neo4j — AgentMemory nodes, their relationships to citing conversations/answers, and embeddings used for recall/search.

## States
- **Empty:** "No memories recorded yet" with a pointer to how memories get created (agent turns, manual save, import).
- **Loading:** `TableSkeleton` behind Suspense while `agent.memory.list` streams in.
- **Error:** list/CRUD failures fail open to the existing list state with an inline toast; promotion confirmation errors block the promotion (never silently apply a FACT).

## Existing implementation
- **Today:** `apps/app/src/app/[orgSlug]/[workspaceSlug]/knowledge/memories/page.tsx` is COMPLETE for CRUD + promote + bulk import (7 bound actions). Rename directory `memories` → `memory`; add the citations view, evidence attach, and promotion-candidates queue as new sections.

## Vision alignment
Cited, decaying, human-confirmed-for-facts memory is grounding plus governance in miniature — durable knowledge that's auditable, not silently accumulating; P1 because unreviewed memory promotion is as risky to trust as unreviewed graph inference.

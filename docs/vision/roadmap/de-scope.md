# De-Scope Document — Aggressive Pruning for Context Engine Focus

> Principle: Every feature that doesn't directly serve the context/memory mission is a
> distraction. Sunset what's dead, freeze what's tangential, realign what has potential.

---

## Decision Framework

| Category | Definition | Action |
|---|---|---|
| **Sunset** | Remove from platform. Delete code, drop schemas, remove from surfaces. | Active removal |
| **Freeze** | No new investment. Maintain for existing users only. No bug fixes beyond critical. | Passive maintenance |
| **Realign** | Keep but refactor toward the vision. Becomes a consumer of Engram. | Active transformation |

---

## Sunset (Remove)

### 1. Form Generation Capabilities (`form.*`)

**What**: `form.generate`, `form.template.list`, `form.submission.read` and related capabilities. Schema: `form.*` tables in Postgres.

**Why sunset**: Form generation is a standalone product feature unrelated to agent context or memory. It was an early experiment that never gained traction. No active users depend on it as a core workflow.

**Action**:
- Remove capability contracts: `packages/oxagen/src/contracts/form.*`
- Remove handlers: `packages/handlers/src/form.*`
- Drop Postgres schema: `form.*` tables via migration
- Remove CLI commands: `apps/cli/src/commands/form.*`
- Remove MCP tools: `apps/mcp/src/tools/form.*`
- Timeline: Phase A (parallel track, low risk)

### 2. Video Generation (`video.generate`, `video.status`)

**What**: AI video generation via Runway/other providers. Generates videos from text/image prompts.

**Why sunset**: Content generation ≠ context engineering. Video generation is a commodity API wrapper that adds no moat and distracts from the memory substrate work.

**Action**:
- Remove capability contracts and handlers
- Remove from AI package (`packages/ai/src/generate-video.ts`)
- Remove related UI in web app
- Timeline: Phase A

### 3. SVG/Image Generation (non-diagram)

**What**: Decorative image/SVG generation capabilities (not diagram generation for agent planning).

**Why sunset**: Same reasoning as video — content creation, not context engineering.

**Action**:
- Remove `image.generate` capability (keep `image.upload` for asset management)
- Remove `packages/ai/src/generate-image.ts`
- Timeline: Phase A

### 4. `readWorkspaceContext` (OXA-1508)

**What**: Feature-flagged function in `packages/agent/src/runtime/knowledge-graph.ts` that returns `[]`.

**Why sunset**: Dead code. Has never returned real data. The entire approach (inject raw graph context into prompt) is superseded by `engram.compile()`.

**Action**:
- Delete `readWorkspaceContext` function
- Remove feature flag `KNOWLEDGE_GRAPH_ENABLED` logic
- Remove the `injectContext` helper (replaced by Engram's layout system)
- Keep `isKnowledgeGraphEnabled()` if needed for other graph operations
- Timeline: Phase B (when `compile()` replaces it)

---

## Freeze (No Investment)

### 5. Playbook System (`automation.*`)

**What**: Event-triggered automation system. `automation.create`, `automation.enable`, `automation.execute`. Uses `playbook.run.execute` Inngest function. Schema: `automation.*` tables.

**Why freeze**: The playbook system is a proto-agent-workflow that predates the context engine vision. It triggers actions based on events but doesn't use memory, doesn't learn, and duplicates what a memory-aware agent can do natively. However, existing customers may depend on configured playbooks.

**Freeze rules**:
- No new playbook features
- Critical bug fixes only (security, data loss)
- Existing playbooks continue to run
- No new UI development in the automation section
- Revisit in Phase D: playbook triggers may become procedural memory triggers

**Future**: In Phase D, evaluate whether playbook triggers can be expressed as procedural memory records that fire the consolidation pipeline or agent workflows.

### 6. Content Schema (`content.documents`, `content.assets`, `content.brand_kits`)

**What**: Generic document/asset storage system. Brand kits, document templates, content management.

**Why freeze**: Content storage is not memory. Documents that matter will be ingested through the ingestion pipeline and represented as entity/relational memory in the graph. The `content.*` schema is a CMS feature, not a context engine feature.

**Freeze rules**:
- No new content management features
- Existing documents remain accessible
- Assets (blob storage) continue to work
- Brand kits are frozen in current state

**Future**: In Phase C, evaluate whether `content.assets` should become blob references in Engram records.

### 7. Video/SVG Generation (Diagram Variant)

**What**: Diagram generation used in agent planning (Mermaid, SVG diagrams).

**Why freeze** (not sunset): Diagram generation for agent planning has some context value (visual representation of plans), but it's not on the critical path for the context engine.

**Freeze rules**:
- Keep existing diagram capabilities working
- No new diagram types or providers
- No performance optimization

### 8. Workflow Schema (`workflow.*`)

**What**: `workflow_runs`, `workflow_steps`, `workflow_templates` tables in Postgres. Partially duplicates `agent.agent_executions`.

**Why freeze**: The workflow schema was an early attempt at agent orchestration state that now conflicts with `agent.agent_executions` and will be superseded by Engram's event-sourced sessions.

**Freeze rules**:
- No new workflow features
- Existing workflow runs complete normally
- No schema changes
- Do not create new `workflow_runs` records in new code

**Future**: In Phase C, migrate active workflow state to the event-sourced session model. Drop `workflow.*` tables after migration is verified.

---

## Realign (Keep + Transform)

### 9. Agent Memory (`packages/agent/src/memory/neo4j.ts`)

**Current**: `writeMemory()` / `recallMemories()` — vector recall + write to Neo4j `AgentMemory` nodes with weight scoring.

**Realignment**: This is the direct predecessor to Engram's semantic memory. Keep it running during Phase A/B, then migrate:

- Phase A: `writeMemory()` dual-writes to both Neo4j and Engram episodic store
- Phase B: `recallMemories()` delegates to `engram.compile()` instead of direct Neo4j vector query
- Phase C: Remove Neo4j `AgentMemory` write path; Engram is the source of truth
- Keep Neo4j for entity/relational graph (it's good at that)

### 10. Knowledge Graph Injection (`packages/agent/src/runtime/knowledge-graph.ts`)

**Current**: `injectContext()` prepends context blocks as a system message. Currently returns `[]`.

**Realignment**: The concept is correct (inject knowledge into agent context), the implementation is wrong (raw text prepend, not compiled). Replace with Engram integration:

- Phase B: `compile()` produces the context window that replaces `injectContext()`
- The `ContextBlock` interface evolves into `MemoryRecord` with proper typing
- Graph traversal moves into Engram's retrieval engine (`retrieval/graph.ts`)

### 11. Skills System (`packages/skills`)

**Current**: Filesystem-first `.skill.md` files with YAML frontmatter, registry, lazy loader. All skills are injected based on registry state, not relevance.

**Realignment**: Skills are procedural memory. The filesystem format is good (ADR-008). What changes is how they're selected:

- Phase A: Add `embedding` field to skill index (pre-computed on load)
- Phase B: Skills are retrieval candidates in `compile()`, scored by relevance to the current task
- Phase D: Consolidation can promote successful agent patterns into new skill files
- Keep: File-based format, tenant override, YAML frontmatter, lazy loading
- Change: Selection goes from "load all matching" to "retrieve top-k relevant"

### 12. Ingestion Pipeline (`packages/ingestion`)

**Current**: Connectors → normalize → dedup → upsert → embed → infer semantic edges. Tree-sitter code parsers.

**Realignment**: Ingestion feeds the entity/relational memory layer. It's already doing the right thing — it just needs to also emit Engram records:

- Phase A: Ingestion pipeline emits episodic events to Engram on each run
- Phase C: Tree-sitter parsers feed the incremental code graph (file-watch mode)
- Phase D: Ingestion events are consolidated into semantic records
- Keep: All connectors, dedup logic, edge inference
- Add: Engram record emission, incremental file-watch mode for code

### 13. Research Swarm

**Current**: Partially built multi-agent swarm for research tasks. Ad-hoc subagent coordination without shared memory.

**Realignment**: The research swarm is the prototype for the multi-agent blackboard:

- Phase E: Refactor swarm to use the blackboard memory bus
- Replace ad-hoc discovery sharing with namespace-scoped writes
- Add intent ledger to prevent duplicate searches
- Keep: Fan-out pattern, research-specific tool selection
- Change: Shared memory replaces message-passing; lineage tracking added

### 14. Telemetry (`packages/telemetry`)

**Current**: ClickHouse append-only events — security events, token usage, agent metrics.

**Realignment**: Telemetry events ARE episodic memory. They just need to be content-addressed and queryable by the context compiler:

- Phase A: Telemetry events emit corresponding Engram episodic records
- Phase B: Telemetry is a retrieval source for `compile()` (temporal index)
- Keep: ClickHouse as the backing store for cloud episodic
- Add: Content addressing, salience scoring on emission

### 15. MCP Snapshots

**Current**: Tool schemas from external MCP servers are snapshotted but not maintained as a live index.

**Realignment**: MCP tool schemas are entity/relational memory (what tools exist, what they do):

- Phase C: Structured tool I/O — tool results are indexed Engram records, not raw text
- Phase C: MCP tool schemas become entity nodes in the code graph, maintained live
- Keep: Snapshot mechanism for initial discovery
- Add: Live index maintenance, structured result indexing

---

## Impact Summary

| Category | Count | Effort | Risk |
|---|---|---|---|
| Sunset | 4 features | Low (delete code) | Low (unused features) |
| Freeze | 4 features | Zero (stop investing) | Low (existing users unaffected) |
| Realign | 7 features | Medium (incremental over phases) | Medium (migration complexity) |

### Code Reduction Estimate

| Sunset Target | Approximate Lines | Packages Affected |
|---|---|---|
| Form generation | ~2,000 LOC | oxagen, handlers, cli, mcp, database |
| Video generation | ~500 LOC | ai, oxagen, handlers |
| Image generation | ~300 LOC | ai, oxagen, handlers |
| readWorkspaceContext | ~80 LOC | agent |
| **Total removed** | **~2,880 LOC** | |

### Schema Tables Dropped

| Schema | Tables | Notes |
|---|---|---|
| `form.*` | ~4 tables | Full schema drop |
| `workflow.*` | ~3 tables | After Phase C migration |

---

## Execution Order

1. **Immediate** (can start now, parallel to Phase A):
   - Sunset form generation (low risk, no dependencies)
   - Sunset video/image generation (low risk)
   - Freeze playbook system (just stop investing)
   - Freeze content schema

2. **Phase A** (during memory substrate work):
   - Begin dual-write for agent memory
   - Begin episodic emission from telemetry

3. **Phase B** (when compiler lands):
   - Sunset `readWorkspaceContext`
   - Complete agent memory realignment
   - Skills retrieval integration

4. **Phase C** (Cortex work):
   - Migrate workflow state to sessions
   - Incremental code graph from ingestion parsers
   - MCP live index

5. **Phase E** (blackboard):
   - Research swarm → blackboard migration

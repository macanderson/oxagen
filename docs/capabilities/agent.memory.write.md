# agent.memory.write

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Persist a two-axis memory tied to a graph node. Memory has two independent
axes — `memoryClass` (epistemic status: OBSERVATION → RULE → FACT) and
`memoryKind` (content domain) — and two independent weights: `confidenceScore`
(how sure it is true; auto-decays) and `enforcementScore` (how strongly it must
be followed; policy). New writes start as OBSERVATION at confidence 100. See
`docs/specs/two-axis-memory/DESIGN.md`.

## Input

| Field              | Type                                             | Notes                                                     |
| ------------------ | ------------------------------------------------ | --------------------------------------------------------- |
| `nodeRef`          | `string`                                         | Graph node ref the memory anchors to.                     |
| `memoryClass`      | `"OBSERVATION" \| "RULE" \| "FACT"`              | Defaults to OBSERVATION.                                   |
| `memoryKind`       | `string`                                         | Content domain (extensible; e.g. STYLE, PREFERENCE).      |
| `enforcementScore` | `int 1–100` (optional)                           | Required when `memoryClass` is RULE; ignored otherwise.   |
| `lesson`           | `string` (1 – 2000)                              | The memory body, in prose.                                |
| `source`           | `"feature" \| "fix" \| "exception-watcher" \| "bug-report"` | Provenance → `createdByKind`/`createdById`.     |
| `relatedNodeIds`   | `string[]` (≤20, optional)                       | KnowledgeNode publicIds → `:ABOUT` edges.                 |

## Output

| Field          | Type     | Notes                                        |
| -------------- | -------- | -------------------------------------------- |
| `memoryId`     | `string` | Neo4j node id.                               |
| `nodeRef`      | `string` | Echoes the anchored node ref.                |
| `edgesCreated` | `number` | Count of `:ABOUT` edges created.             |

## Invariants

- FACT ⟹ confirmed by a USER and enforcement 100 (set via `agent.memory.promote`, not here).
- OBSERVATION ⟹ enforcement is null.
- RULE ⟹ enforcement 1–100.

## Side effects

- Neo4j: MERGE `(:AgentMemory)` on (org, workspace, nodeRef, lesson); create `:REMEMBERS`/`:ABOUT` edges.

## SPEC references

- `docs/specs/two-axis-memory/DESIGN.md`

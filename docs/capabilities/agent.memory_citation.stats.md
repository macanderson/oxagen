# agent.memory.citations.stats

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Workspace-wide citation analytics across all executions: which memories and
graph nodes agents actually cite, how useful those citations were (influence),
and where rules get violated (compliance). Aggregates the Neo4j `:Citation`
graph — `(:Execution)-[:CITED]->(:Citation)-[:OF]->(:AgentMemory | :GraphNode)`
— the cross-execution rollup that `agent.memory.citations.list` (per-execution)
cannot answer. Backs the Knowledge → Citations dashboard. See
`docs/specs/two-axis-memory/DESIGN.md` §6/§7.

## Input

| Field   | Type        | Notes                                              |
| ------- | ----------- | -------------------------------------------------- |
| `days`  | `int 1–365` | Window in days for the daily series and totals. Default 30. |
| `limit` | `int 1–50`  | Max entries per top-N list. Default 10.            |

## Output

| Field                 | Type                              | Notes                                                                     |
| --------------------- | --------------------------------- | ------------------------------------------------------------------------- |
| `totals`              | object                            | `citations`, distinct `executions`, `memoriesCited`, `nodesCited`.        |
| `byInfluence`         | `Record<string, number>`          | Citation count per influence level (DECISIVE/CONTRIBUTING/CONSIDERED/IGNORED). |
| `byCompliance`        | `Record<string, number>`          | Citation count per compliance outcome (COMPLIED/DISCRETION/VIOLATION/NA).  |
| `daily`               | `{ date, citations, violations }[]` | Zero-filled per-day series across the window.                             |
| `topMemories`         | `CitedMemoryStat[]`               | Most-cited memories, with influence breakdown.                            |
| `leastUsefulMemories` | `CitedMemoryStat[]`               | Cited ≥3 times but never DECISIVE/CONTRIBUTING.                            |
| `mostViolatedRules`   | `CitedMemoryStat[]`               | RULE/FACT memories ranked by violation citations.                         |
| `topNodes`            | `{ node, citationCount, … }[]`    | Most-cited non-memory graph nodes, resolved to human-label refs.          |

`AgentMemory` nodes also carry the `:GraphNode` label, so node-scoped
aggregations exclude `:AgentMemory`. `topNodes` resolves each node server-side to
the `knowledgeNodeRef` shape (`{ id, label, displayName, properties }`,
coalescing `displayName→name→publicId`) — never a bare id.

## Side effects

- None (read-only). Returns an empty-but-valid rollup when the knowledge graph is not configured.

## Reading the metrics

- **Useful vs not useful:** `DECISIVE` and `CONTRIBUTING` influence means the
  citation actually shaped the agent's output; `CONSIDERED`/`IGNORED` means it
  was recalled but did not matter. A memory that accumulates citations without
  ever being decisive (`leastUsefulMemories`) is a candidate to demote
  (`demote_memory`) or dismiss from the promotion queue.
- **Violations:** `byCompliance.VIOLATION` and `mostViolatedRules` show where
  agents broke promoted rules — either the rule needs stronger enforcement, or
  it is wrong and should be demoted.

## Examples

API — 30-day rollup, top-10 lists (defaults):

```bash
curl -X POST "https://api.oxagen.sh/v1/{org_slug}/{workspace_slug}/agent/memory/citations/stats" \
  -H "Authorization: Bearer $OXAGEN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

API — quarterly window with deeper lists:

```bash
curl -X POST "https://api.oxagen.sh/v1/{org_slug}/{workspace_slug}/agent/memory/citations/stats" \
  -H "Authorization: Bearer $OXAGEN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"days": 90, "limit": 25}'
```

MCP — tool `get_citation_stats`:

```json
{ "days": 7, "limit": 10 }
```

CLI — compact summary in the terminal:

```bash
oxagen memory citations --days 30 --limit 10
```

App: **Knowledge → Citations** renders this capability as the dashboard (period
switcher = `days` 7/30/90).

## SPEC references

- `docs/specs/two-axis-memory/DESIGN.md` §6/§7

# code.map

**Domain:** code
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent, cli
**Risk level:** low
**Requires approval:** no

## Intent

Return a structured code-map bundle for a natural-language concept query. Answers
"give me everything related to \<X\>" in one call instead of requiring multiple
grep/bash/file-search round-trips.

The bundle contains:
- **files** — source files semantically relevant to the query (vector similarity via the same embedding index as `graph.search`)
- **symbols** — top-level symbols (functions, classes, types) contained in those files, gathered via `CONTAINS` edges
- **calls** — `CALLS` edges between matched symbols (empty array when call-edge ingestion has not yet landed)
- **recentChanges** — commits that modified matched files (empty array when commit-edge ingestion has not yet landed)

All four result kinds degrade gracefully: if the underlying graph edges are absent the corresponding arrays are empty, never an error.

## Input

| Field   | Type                                           | Default | Notes                                                                                 |
| ------- | ---------------------------------------------- | ------- | ------------------------------------------------------------------------------------- |
| `query` | `string` (1–1000 chars)                        | req     | Natural-language concept query, e.g. `"payments"`, `"auth session handling"`         |
| `limit` | `integer` (1–50)                               | `20`    | Maximum number of source files to return                                              |
| `kinds` | `Array<"file"\|"symbol"\|"chunk"\|"commit">`?  | all     | Which result sections to populate. `"commit"` controls `recentChanges`.             |
| `domain`| `string`?                                      | —       | Optional domain label filter — only return nodes whose `domain` property matches    |

## Output

```ts
{
  files: Array<{
    nodeId: string;
    path: string;
    language: string;
    displayName: string;
    domain?: string;      // present only when the node carries a domain property
    score: number;        // vector similarity 0–1
  }>;
  symbols: Array<{
    nodeId: string;
    name: string;
    kind: string;         // "function" | "class" | "type" | "interface" | …
    path: string;
    startLine: number;
    endLine: number;
    signature: string;
    docComment?: string;
    domain?: string;
    score: number;
  }>;
  calls: Array<{
    callerNodeId: string;
    calleeNodeId: string;
    callerName: string;
    calleeName: string;
  }>;
  recentChanges: Array<{
    commitSha: string;
    message: string;
    authorName: string;
    committedAt: string;  // ISO 8601
    modifiedFiles: string[];
  }>;
}
```

## API

```
POST /v1/{org}/{workspace}/code/map
Content-Type: application/json

{
  "query": "payments",
  "limit": 20,
  "domain": "billing"
}
```

## MCP

Tool name: `code.map`

## CLI

```bash
oxagen code map "payments" --limit 20 --domain billing
oxagen code map "auth session handling" --json
oxagen code map "stripe webhook" --kinds file,commit
```

## Agent tool

When a `CodeMapProvider` is injected into the agent engine, the `code_map` tool is available. The system prompt instructs the agent to call `code_map` before `grep` or `bash` for conceptual or multi-word queries.

## Enrichment timeline

| Data kind       | Populated by                                  |
| --------------- | --------------------------------------------- |
| `files`         | Today (SourceFile nodes + vector index)       |
| `symbols`       | Today (SourceFile→CONTAINS→SourceSymbol)      |
| `calls`         | When call-edge ingestion lands (in-flight)    |
| `recentChanges` | When Commit→MODIFIED edges land (in-flight)   |

## Side effects

None — read-only.

## Related

- [`graph.search`](graph.search.md) — general-purpose semantic search across all node types
- [`code.diff`](code.diff.md) — unified diff between two file blobs
- [`code.patch`](code.patch.md) — apply a unified diff to a workspace

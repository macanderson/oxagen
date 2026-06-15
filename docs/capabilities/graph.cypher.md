# graph.cypher

**Domain:** graph
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent, cli
**Risk level:** high

## Intent

Execute a Cypher query against the knowledge graph. When nlQuery=true, natural
language is translated to Cypher by an LLM (sandboxed to read-only). Raw
Cypher (nlQuery=false) is available to privileged roles only and supports both
reads and writes.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| query | string | Cypher query or natural language description (1-10000 chars) |
| nlQuery | boolean | Treat query as natural language (LLM translates to read-only Cypher, default: false) |
| params | object? | Named parameters to bind into query (string, number, boolean values) (optional) |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| rows | array | Result rows as plain objects |
| columns | array of strings | Column names in result order |
| rowCount | number | Number of rows returned |

## Side effects

Neo4j read or write depending on query type. If nlQuery=true, LLM call for
translation (ClickHouse telemetry). Results streamed to caller.

## Errors

None explicitly defined in the contract (Cypher syntax errors returned as rows).

# web.search

**Domain:** web
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Search the web using the Tavily API and return ranked results with title, URL,
and content snippets.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| query | string | Search query (1-500 chars) |
| maxResults | number | Maximum results to return: 1-10 (default: 5) |
| searchDepth | enum | Search depth: "basic" (faster) or "advanced" (thorough) (default: "basic") |
| includeDomains | array of strings? | Restrict results to these domains (optional) |
| excludeDomains | array of strings? | Exclude results from these domains (optional) |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| results | array of objects | Ranked search results |
| totalResults | number | Total matching results available (may exceed maxResults) |
| searchId | string | Search ID for reference/logging |

Each result object:
- title: string
- url: string
- content: string (snippet)
- score: number (relevance score)
- publishedDate: string? (optional, ISO 8601)

## Side effects

Tavily API call (external service). Results cached. ClickHouse telemetry.

## Errors

None explicitly defined in the contract.

# web.fetch

**Domain:** web
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Fetch a URL and return its content as clean markdown text. Useful for reading
web pages, documentation, or articles.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| url | string | URL to fetch (http:// or https://) |
| extractMarkdown | boolean | Convert HTML to readable markdown (default: true) |
| timeout | number | Request timeout in milliseconds: 1000-30000 (default: 10000) |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| url | string | URL that was fetched |
| title | string | Page title (from <title> tag or inferred) |
| content | string | Page content as markdown |
| wordCount | number | Word count of extracted content |
| fetchedAt | string | ISO 8601 timestamp of fetch completion |
| statusCode | number | HTTP status code (200, 404, etc.) |

## Side effects

HTTP request to external URL. Content cached briefly. ClickHouse telemetry.

## Errors

None explicitly defined in the contract (HTTP errors returned with statusCode).

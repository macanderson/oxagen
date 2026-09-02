/**
 * `@oxagen/web` — the two outbound-web primitives the platform calls.
 *
 * `webSearch` asks Tavily a question. `webFetch` downloads one page and turns
 * it into markdown. Both reach the public internet from the server, and both
 * return third-party text: treat every string that comes back as untrusted,
 * and read each function's own doc comment for what it does NOT guard against
 * (host restriction, body size, redirect reporting).
 *
 * Neither function enforces IAM, metering, or tenancy. Those live in the
 * capability handlers in `@oxagen/handlers` that wrap these; call through the
 * `search_web` / `fetch_web_page` contracts, not directly.
 */
export { webSearch } from "./search";
export type { SearchOptions, SearchResponse, SearchResult } from "./search";

export { webFetch, extractMarkdownFromHtml } from "./fetch";
export type { FetchOptions, FetchResponse } from "./fetch";
